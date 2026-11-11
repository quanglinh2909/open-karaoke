#!/usr/bin/env bash
# Builds the full Open Karaoke installer for Linux: a .deb that ships the
# tools (yt-dlp, Deno), every AI model (~1.6 GB) and the ONNX Runtime library
# this Ubuntu 22.04 build links to, so it works on another PC without
# downloading anything first (as build-installer.cmd on Windows). The tools
# and models are taken from this PC's app data, so open the app once and use
# every feature (separate a song, Fit lyrics) before building.
# The first release build takes a while (15-30 min).
# Run it from any directory: ./build-installer.sh
set -e
cd "$(dirname "$0")"
. scripts/linux-build-env.sh

SRC="$HOME/.local/share/app.openkaraoke.desktop/bin"
DST="src-tauri/bundled"
for f in yt-dlp deno models/UVR-MDX-NET-Inst_HQ_3.onnx models/ggml-large-v3-turbo-q5_0.bin models/mms-300m-fa-int8.onnx models/swift-f0.onnx; do
  if [ ! -f "$SRC/$f" ]; then
    echo "Missing $SRC/$f"
    echo "Open the app and use it once (separate a song, press Fit lyrics) so it downloads everything, then build again."
    exit 1
  fi
done

echo "Gathering tools and models into $DST ..."
rm -rf "$DST/bin" "$DST/ort"
mkdir -p "$DST/ort"
# Hard links when on the same disk (instant, no extra space), else copies.
cp -al "$SRC" "$DST/bin" 2>/dev/null || cp -a "$SRC" "$DST/bin"
find "$DST/bin" \( -name '.ytdlp-updated' -o -name '*.download' -o -name '*.part' -o -name '*.adopt' \) -delete
cp -L "$ORT_DIR/libonnxruntime.so.1" "$ORT_DIR/libonnxruntime_providers_shared.so" "$DST/ort/"

# The app finds ONNX Runtime where the .deb puts it: /usr/lib/open-karaoke,
# next to /usr/bin (no LD_LIBRARY_PATH needed once installed).
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C link-arg=-Wl,-rpath,\$ORIGIN/../lib/open-karaoke"

if ! npm run dist -- --config src-tauri/tauri.linux.bundle.conf.json; then
  echo
  echo "Build failed. Scroll up for the error."
  exit 1
fi

OUT="src-tauri/target/release/bundle/deb"
echo
echo "Done. The installer is in $OUT:"
ls -lh "$OUT"/*.deb
echo "Install it with: sudo apt install ./$OUT/<file>.deb"
