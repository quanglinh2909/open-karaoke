#!/usr/bin/env python3
"""Convert a Hugging Face Whisper fine-tune (safetensors) to a whisper.cpp
ggml model, optionally quantised to q5_0. Needs only numpy (no PyTorch).

Based on whisper.cpp's models/convert-h5-to-ggml.py (MIT) and ggml's
quantize_row_q5_0_ref, which it reproduces bit for bit.

    python3 scripts/convert_whisper_hf.py MODEL_DIR MEL_FILTERS.npz OUT.bin [f16|q5_0]

MODEL_DIR holds model.safetensors, config.json, vocab.json and
added_tokens.json; MEL_FILTERS.npz is whisper/assets/mel_filters.npz from
github.com/openai/whisper.
"""

import json
import struct
import sys
from pathlib import Path

import numpy as np

CONV_MAP = {
    "self_attn.k_proj": "attn.key",
    "self_attn.q_proj": "attn.query",
    "self_attn.v_proj": "attn.value",
    "self_attn.out_proj": "attn.out",
    "self_attn_layer_norm": "attn_ln",
    "encoder_attn.q_proj": "cross_attn.query",
    "encoder_attn.v_proj": "cross_attn.value",
    "encoder_attn.out_proj": "cross_attn.out",
    "encoder_attn_layer_norm": "cross_attn_ln",
    "fc1": "mlp.0",
    "fc2": "mlp.2",
    "final_layer_norm": "mlp_ln",
    "encoder.layer_norm.bias": "encoder.ln_post.bias",
    "encoder.layer_norm.weight": "encoder.ln_post.weight",
    "encoder.embed_positions.weight": "encoder.positional_embedding",
    "decoder.layer_norm.bias": "decoder.ln.bias",
    "decoder.layer_norm.weight": "decoder.ln.weight",
    "decoder.embed_positions.weight": "decoder.positional_embedding",
    "decoder.embed_tokens.weight": "decoder.token_embedding.weight",
}

# Kept in float32 (as whisper.cpp's converter and quantiser do).
F32_NAMES = {
    "encoder.conv1.bias",
    "encoder.conv2.bias",
    "encoder.positional_embedding",
    "decoder.positional_embedding",
}

GGML_TYPE_F32, GGML_TYPE_F16, GGML_TYPE_Q5_0 = 0, 1, 6
GGML_FTYPE_MOSTLY_F16, GGML_FTYPE_MOSTLY_Q5_0 = 1, 8
GGML_QNT_VERSION_FACTOR = 1000
GGML_QNT_VERSION = 2


def bytes_to_unicode():
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(2**8):
        if b not in bs:
            bs.append(b)
            cs.append(2**8 + n)
            n += 1
    return dict(zip(bs, [chr(c) for c in cs]))


def read_safetensors(path: Path):
    """name -> numpy array (memory-mapped)."""
    with path.open("rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        header = json.loads(f.read(n))
    header.pop("__metadata__", None)
    mm = np.memmap(path, dtype=np.uint8, mode="r", offset=8 + n)
    dtypes = {"F16": np.float16, "F32": np.float32}
    out = {}
    for name, info in header.items():
        a, b = info["data_offsets"]
        out[name] = mm[a:b].view(dtypes[info["dtype"]]).reshape(info["shape"])
    return out


def ggml_name(src: str) -> str:
    nn = src.split(".")[1:]  # drop "model."
    if nn[1] == "layers":
        nn[1] = "blocks"
        mid = ".".join(nn[3:-1])
        if mid == "encoder_attn.k_proj":
            mapped = "attn.key" if nn[0] == "encoder" else "cross_attn.key"
        else:
            mapped = CONV_MAP[mid]
        return ".".join(nn[:3] + [mapped] + nn[-1:])
    name = ".".join(nn)
    return CONV_MAP.get(name, name)


def quantize_q5_0(x: np.ndarray) -> bytes:
    """ggml quantize_row_q5_0_ref over rows of a 2-D float32 array."""
    blocks = x.astype(np.float32).reshape(-1, 32)
    idx = np.argmax(np.abs(blocks), axis=1)
    mx = blocks[np.arange(len(blocks)), idx]  # signed value of largest magnitude
    d = (mx / -16.0).astype(np.float32)
    with np.errstate(divide="ignore"):
        inv = np.where(d != 0, np.float32(1.0) / d, np.float32(0.0)).astype(np.float32)
    q = blocks * inv[:, None]
    # C: MIN(31, (int8_t)(x + 16.5f)), a truncating conversion.
    q = np.minimum(31, np.trunc(q + np.float32(16.5)).astype(np.int8)).astype(np.uint8)
    lo, hi = q[:, :16], q[:, 16:]
    qs = (lo & 0x0F) | ((hi & 0x0F) << 4)
    bits = np.arange(16, dtype=np.uint32)
    qh = (((lo >> 4) & 1).astype(np.uint32) << bits).sum(axis=1, dtype=np.uint32) | (
        ((hi >> 4) & 1).astype(np.uint32) << (bits + 16)
    ).sum(axis=1, dtype=np.uint32)
    rec = np.empty(len(blocks), dtype=[("d", "<f2"), ("qh", "<u4"), ("qs", "u1", 16)])
    rec["d"] = d.astype(np.float16)
    rec["qh"] = qh
    rec["qs"] = qs
    return rec.tobytes()


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    model_dir, mel_path, out_path = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    mode = sys.argv[4] if len(sys.argv) > 4 else "q5_0"
    assert mode in ("f16", "q5_0")

    hp = json.load((model_dir / "config.json").open(encoding="utf8"))
    vocab = json.load((model_dir / "vocab.json").open(encoding="utf8"))
    max_length = hp.get("max_length") or hp.get("max_target_positions", 448)
    n_mels = hp["num_mel_bins"]
    filters = np.load(mel_path)[f"mel_{n_mels}"].astype(np.float32)
    ftype = GGML_FTYPE_MOSTLY_F16 if mode == "f16" else GGML_FTYPE_MOSTLY_Q5_0 + GGML_QNT_VERSION * GGML_QNT_VERSION_FACTOR

    tensors = read_safetensors(model_dir / "model.safetensors")
    with out_path.open("wb") as f:
        f.write(struct.pack("i", 0x67676D6C))
        for v in (
            hp["vocab_size"],
            hp["max_source_positions"],
            hp["d_model"],
            hp["encoder_attention_heads"],
            hp["encoder_layers"],
            int(max_length),
            hp["d_model"],
            hp["decoder_attention_heads"],
            hp["decoder_layers"],
            n_mels,
            ftype,
        ):
            f.write(struct.pack("i", v))
        f.write(struct.pack("ii", *filters.shape))
        f.write(filters.tobytes())

        decoder = {v: k for k, v in bytes_to_unicode().items()}
        f.write(struct.pack("i", len(vocab)))
        for tok, _ in sorted(vocab.items(), key=lambda kv: kv[1]):
            text = bytes(decoder[c] for c in tok)
            f.write(struct.pack("i", len(text)))
            f.write(text)

        counts = {}
        for src, arr in tensors.items():
            if src == "proj_out.weight":  # tied to the token embedding
                continue
            name = ggml_name(src)
            data = np.squeeze(arr)
            if name in ("encoder.conv1.bias", "encoder.conv2.bias"):
                data = data.reshape(data.shape[0], 1)
            n_dims = data.ndim
            if n_dims < 2 or name in F32_NAMES:
                ttype, payload = GGML_TYPE_F32, data.astype(np.float32).tobytes()
            elif mode == "q5_0" and n_dims == 2 and data.shape[-1] % 32 == 0:
                ttype, payload = GGML_TYPE_Q5_0, quantize_q5_0(data)
            else:
                ttype, payload = GGML_TYPE_F16, data.astype(np.float16).tobytes()
            counts[ttype] = counts.get(ttype, 0) + 1
            encoded = name.encode("utf-8")
            f.write(struct.pack("iii", n_dims, len(encoded), ttype))
            for i in range(n_dims):
                f.write(struct.pack("i", data.shape[n_dims - 1 - i]))
            f.write(encoded)
            f.write(payload)
    print(f"wrote {out_path} ({mode}); tensors by type {counts}")


if __name__ == "__main__":
    main()
