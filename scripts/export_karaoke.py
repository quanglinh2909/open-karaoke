"""Export aufr33 & viperx's Mel-Band Roformer karaoke model (lead vocal vs
the rest) to ONNX, for splitting a separated vocal into the lead singer and
the backing vocals. The app does the STFT and the inverse STFT; the ONNX
graph takes the spectrogram and returns the lead's complex mask, already
averaged over the overlapping mel bands (so the output has the same layout
as the male/female model's: [1, stems, (f s)=2050, t, c=2], t = 401 here).

usage: python export_karaoke.py MSST_DIR CONFIG.yaml MODEL.ckpt OUT.onnx [--no-check | --check-only VOCALS.wav]
(MSST_DIR: a checkout of ZFTurbo/Music-Source-Separation-Training). Run it
through scripts/export_karaoke.sh, which caps its memory: the export alone
takes several GB, and doing it and the check in one process froze a 32 GB
desktop that was already busy."""
import os
import sys

import numpy as np
import torch
import yaml
from einops import pack, rearrange, unpack

src, cfg_path, ckpt_path, out_path = sys.argv[1:5]
mode = sys.argv[5] if len(sys.argv) > 5 else ""
vocals = sys.argv[6] if mode == "--check-only" and len(sys.argv) > 6 else None
torch.set_num_threads(int(os.environ.get("OMP_NUM_THREADS", "4")))
sys.path.insert(0, src)
from models.bs_roformer.mel_band_roformer import MelBandRoformer  # noqa: E402

cfg = yaml.unsafe_load(open(cfg_path))  # the config uses !!python/tuple
model = MelBandRoformer(**cfg["model"])
state = torch.load(ckpt_path, map_location="cpu", weights_only=True)  # tensors only: no code from the file runs
if isinstance(state, dict) and "state_dict" in state:
    state = state["state_dict"]
model.load_state_dict(state)
model.eval()

# Frames per chunk. Trained on 801 (8 s at hop 441), but its time attention
# then holds 60 bands × 8 heads × 801² floats several times over: over 6 GB.
# At 401 (4 s) a quarter of that; the app overlaps and crossfades chunks.
T = int(os.environ.get("OK_FRAMES", "401"))
F2 = 1025 * 2  # frequency bins x stereo channels, interleaved (f s)


class Core(torch.nn.Module):
    """MelBandRoformer.forward between the STFT and the masking, with the
    masks scattered back to every bin and averaged where bands overlap."""

    def __init__(self, m):
        super().__init__()
        self.m = m
        self.register_buffer("idx", m.freq_indices.clone())
        denom = m.num_bands_per_freq.repeat_interleave(2).float().clamp(min=1e-8)  # (f s)
        self.register_buffer("denom", denom)

    def forward(self, spec):  # [1, (f s)=2050, t, c=2]
        m = self.m
        x = spec[:, self.idx]  # [1, F', t, 2]
        x = rearrange(x, "b f t c -> b t (f c)")
        x = m.band_split(x)
        for block in m.layers:
            time_t, freq_t = block[-2], block[-1]
            x = rearrange(x, "b t f d -> b f t d")
            x, ps = pack([x], "* t d")
            x = time_t(x)
            (x,) = unpack(x, ps, "* t d")
            x = rearrange(x, "b f t d -> b t f d")
            x, ps = pack([x], "* f d")
            x = freq_t(x)
            (x,) = unpack(x, ps, "* f d")
        mask = torch.stack([fn(x) for fn in m.mask_estimators], dim=1)
        mask = rearrange(mask, "b n t (f c) -> b n f t c", c=2)  # [1, n, F', t, 2]
        n, t = mask.shape[1], mask.shape[3]
        out = torch.zeros(1, n, F2, t, 2, dtype=mask.dtype)
        index = self.idx.view(1, 1, -1, 1, 1).expand(1, n, -1, t, 2)
        out = out.scatter_add(2, index, mask)
        return out / self.denom.view(1, 1, -1, 1, 1)  # [1, n, 2050, t, 2]


if mode != "--check-only":
    core = Core(model).eval()
    dummy = torch.randn(1, F2, T, 2)
    with torch.no_grad():
        torch.onnx.export(core, (dummy,), out_path, input_names=["spec"], output_names=["mask"], opset_version=17, dynamo=False)
    print("exported", out_path)
    if mode == "--no-check":
        sys.exit(0)

# Check: the app's pipeline (STFT -> ONNX mask -> iSTFT) against the model itself.
import onnxruntime as ort  # noqa: E402

if vocals:
    import wave

    w = wave.open(vocals)
    rate, n = w.getframerate(), w.getnframes()
    raw = np.frombuffer(w.readframes(n), dtype=np.int16 if w.getsampwidth() == 2 else np.int32).astype(np.float32)
    raw = raw.reshape(-1, w.getnchannels()).T / (32768.0 if w.getsampwidth() == 2 else 2147483648.0)
    start = int(60.0 * rate)
    audio = torch.tensor(raw[:, start : start + (T - 1) * 441].copy())
else:
    audio = torch.randn(2, (T - 1) * 441) * 0.1
audio = audio[None]  # [1, 2, samples]
with torch.no_grad():
    ref = model(audio)  # [1, 2 ch, t] (one stem: the lead)
win = torch.hann_window(2048)
spec = torch.stft(audio[0], n_fft=2048, hop_length=441, win_length=2048, window=win, center=True, return_complex=True)
spec_in = rearrange(torch.view_as_real(spec), "s f t c -> 1 (f s) t c").numpy()
opts = ort.SessionOptions()
opts.intra_op_num_threads = torch.get_num_threads()
opts.enable_cpu_mem_arena = False
sess = ort.InferenceSession(out_path, opts, providers=["CPUExecutionProvider"])
mask = sess.run(None, {"spec": spec_in})[0]  # [1, 1, 2050, t, 2]
mask_c = torch.view_as_complex(torch.tensor(mask[0, 0]).contiguous())  # [(f s), t]
spec_fs = rearrange(spec, "s f t -> (f s) t")
lead = rearrange(spec_fs * mask_c, "(f s) t -> s f t", s=2)
lead[:, 0] = 0  # the model zeroes the DC bin
out = torch.istft(lead, n_fft=2048, hop_length=441, win_length=2048, window=win, center=True, length=audio.shape[-1])
ref = ref.reshape(2, -1)
err = (out - ref).abs().max().item()
print(f"max difference from the model: {err:.2e} (peak {ref.abs().max().item():.3f})")
