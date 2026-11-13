#!/usr/bin/env bash
# Make the lead/backing karaoke model for the app (ONNX), safely:
# downloads into ~/.cache/open-karaoke-export (kept across reboots), and runs
# the export capped at 8 GB of RAM and 6 cores at the lowest priority, so it
# is stopped instead of freezing the computer if it needs more.
#
# usage: scripts/export_karaoke.sh [VOCALS.wav]   (a separated vocal, to check it)
# The model lands in the app's models dir as mel_roformer_karaoke.onnx.
set -euo pipefail

WORK="${WORK:-$HOME/.cache/open-karaoke-export}"
MODELS="${MODELS:-$HOME/.local/share/app.openkaraoke.desktop/bin/models}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="https://huggingface.co/Politrees/UVR_resources/resolve/main/models/Roformer/MelBand"
mkdir -p "$WORK/model" "$WORK/src"

if [ ! -s "$WORK/model/model.ckpt" ] || [ "$(stat -c %s "$WORK/model/model.ckpt")" != 913096801 ]; then
  echo "Tải mô hình (913 MB)…"
  curl -fL --retry 3 -o "$WORK/model/config.yaml" "$SRC/config_melband_roformer_karaoke_aufr33_viperx_sdr_10.1956.yaml"
  curl -fL --retry 3 -C - -o "$WORK/model/model.ckpt" "$SRC/mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
fi
if [ ! -d "$WORK/src/msst" ]; then
  echo "Tải mã nguồn mô hình (Music-Source-Separation-Training)…"
  git clone --depth 1 -q https://github.com/ZFTurbo/Music-Source-Separation-Training.git "$WORK/src/msst"
fi
if [ ! -x "$WORK/venv/bin/python" ]; then
  echo "Tạo môi trường Python (dùng PyTorch của máy)…"
  python3 -m venv --system-site-packages "$WORK/venv"
  "$WORK/venv/bin/pip" install -q beartype rotary-embedding-torch librosa einops pyyaml
fi

# Capped: 8 GB of memory (no swap), 6 cores, lowest priority.
run() {
  OMP_NUM_THREADS=6 MKL_NUM_THREADS=6 systemd-run --user --scope --quiet \
    -p MemoryMax=8G -p MemorySwapMax=0 -p CPUQuota=600% \
    nice -n 19 "$WORK/venv/bin/python" "$@"
}

mkdir -p "$MODELS"
OUT="$MODELS/mel_roformer_karaoke.onnx"
echo "Xuất ONNX (vài phút)…"
run "$HERE/export_karaoke.py" "$WORK/src/msst" "$WORK/model/config.yaml" "$WORK/model/model.ckpt" "$OUT" --no-check
if [ $# -ge 1 ]; then
  echo "So khớp với mô hình gốc…"
  run "$HERE/export_karaoke.py" "$WORK/src/msst" "$WORK/model/config.yaml" "$WORK/model/model.ckpt" "$OUT" --check-only "$1"
fi
ls -la "$OUT"
echo "Xong."
