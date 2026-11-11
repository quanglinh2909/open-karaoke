"""Export the BS-Roformer male/female model's network (spectrogram in, masks
out) to ONNX; the app does the STFT, the masking and the inverse STFT.
usage: python export_male_female.py SRC_DIR CONFIG.yaml MODEL.ckpt OUT.onnx [VOCALS.wav]"""
import sys
import numpy as np
import torch
import yaml
from einops import pack, rearrange, unpack

src, cfg_path, ckpt_path, out_path = sys.argv[1:5]
sys.path.insert(0, src)
from models.bs_roformer.bs_roformer import BSRoformer  # noqa: E402

cfg = yaml.unsafe_load(open(cfg_path))  # the config uses !!python/tuple
model = BSRoformer(**cfg["model"])
state = torch.load(ckpt_path, map_location="cpu", weights_only=False)
if isinstance(state, dict) and "state_dict" in state:
    state = state["state_dict"]
model.load_state_dict(state)
model.eval()

T = cfg["inference"]["dim_t"]  # 801 frames = 8 s at hop 441
F2 = 1025 * 2  # frequency bins x stereo channels, interleaved (f s)


class Core(torch.nn.Module):
    """BSRoformer.forward between the STFT and the masking, unchanged."""

    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, spec):  # [1, (f s)=2050, t=801, c=2]
        m = self.m
        x = rearrange(spec, "b f t c -> b t (f c)")
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
        x = m.final_norm(x)
        mask = torch.stack([fn(x) for fn in m.mask_estimators], dim=1)
        return rearrange(mask, "b n t (f c) -> b n f t c", c=2)  # [1, 2, 2050, 801, 2]


core = Core(model).eval()
dummy = torch.randn(1, F2, T, 2)
with torch.no_grad():
    torch.onnx.export(core, (dummy,), out_path, input_names=["spec"], output_names=["mask"], opset_version=17, dynamo=False)
print("exported", out_path)

# Check: the app's pipeline (STFT -> ONNX masks -> iSTFT) against the model itself.
import onnxruntime as ort  # noqa: E402

sr = 44100
if len(sys.argv) > 5:
    import wave

    w = wave.open(sys.argv[5])
    rate, n = w.getframerate(), w.getnframes()
    raw = np.frombuffer(w.readframes(n), dtype=np.int16 if w.getsampwidth() == 2 else np.int32).astype(np.float32)
    raw = raw.reshape(-1, w.getnchannels()).T / (32768.0 if w.getsampwidth() == 2 else 2147483648.0)
    start = int(100.0 * rate)
    audio = torch.tensor(raw[:, start : start + 352800].copy())
else:
    audio = torch.randn(2, 352800) * 0.1
audio = audio[None]  # [1, 2, 352800]
with torch.no_grad():
    ref = model(audio)  # [1, 2 stems, 2 ch, t]
win = torch.hann_window(2048)
spec = torch.stft(audio[0], n_fft=2048, hop_length=441, win_length=2048, window=win, center=True, return_complex=True)
spec_r = torch.view_as_real(spec)  # [s, f, t, c]
spec_in = rearrange(spec_r, "s f t c -> 1 (f s) t c").numpy()
sess = ort.InferenceSession(out_path, providers=["CPUExecutionProvider"])
import time

t0 = time.time()
mask = sess.run(None, {"spec": spec_in.astype(np.float32)})[0]  # [1, 2, 2050, 801, 2]
dt = time.time() - t0
mask_c = torch.view_as_complex(torch.tensor(mask[0]).contiguous())  # [n, (f s), t]
spec_c = torch.view_as_complex(torch.tensor(spec_in[0]).contiguous())  # [(f s), t]
out = []
for n in range(2):
    y = rearrange(spec_c * mask_c[n], "(f s) t -> s f t", s=2).clone()
    y[:, 0] = 0  # zero_dc
    out.append(torch.istft(y, n_fft=2048, hop_length=441, win_length=2048, window=win, center=True, length=352800))
out = torch.stack(out)  # [n, s, t]
err = (out - ref[0]).abs().max().item()
print(f"onnx run {dt:.2f}s for 8 s; max |app pipeline - model| = {err:.2e}; stems rms", [round(float(x.pow(2).mean().sqrt()), 4) for x in out])
