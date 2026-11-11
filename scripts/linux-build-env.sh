# Build environment for Ubuntu 22.04 (glibc 2.35), sourced by run-app.sh and
# build-installer.sh. See CLAUDE.md, Prerequisites:
#   - .cargo/config.toml passes MSVC-only CMake flags: override them;
#   - libclang without its own headers: point bindgen at GCC's (stddef.h);
#   - ort's prebuilt ONNX Runtime needs glibc 2.38: link Microsoft's official
#     release (1.31.1) dynamically instead.
# Keep every value stable: cargo rebuilds the native crates when one changes.

ORT_DIR="${ORT_DIR:-$HOME/.local/share/onnxruntime/onnxruntime-linux-x64-1.31.1/lib}"
if [ ! -f "$ORT_DIR/libonnxruntime.so.1" ]; then
  echo "ONNX Runtime not found in $ORT_DIR" >&2
  echo "Unpack onnxruntime-linux-x64-1.31.1 there (or set ORT_DIR)." >&2
  return 1 2>/dev/null || exit 1
fi

export CMAKE_C_FLAGS_RELWITHDEBINFO="-O2 -DNDEBUG"
export CMAKE_CXX_FLAGS_RELWITHDEBINFO="-O2 -DNDEBUG"
export CMAKE_C_FLAGS_RELEASE="-O2 -DNDEBUG"
export CMAKE_CXX_FLAGS_RELEASE="-O2 -DNDEBUG"
export BINDGEN_EXTRA_CLANG_ARGS="-I/usr/lib/gcc/x86_64-linux-gnu/$(gcc -dumpversion)/include"
export ORT_LIB_LOCATION="$ORT_DIR"
export ORT_PREFER_DYNAMIC_LINK=1
export LD_LIBRARY_PATH="$ORT_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
