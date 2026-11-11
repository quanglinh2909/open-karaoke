#!/usr/bin/env bash
# Starts Open Karaoke in development mode (tauri dev) with the build
# environment Ubuntu 22.04 needs (see CLAUDE.md, Prerequisites):
#   - .cargo/config.toml passes MSVC-only CMake flags: override them;
#   - libclang without its own headers: point bindgen at GCC's (stddef.h);
#   - ort's prebuilt ONNX Runtime needs glibc 2.38: link the official
#     release dynamically instead.
# Run it from any directory: ./run-app.sh
set -e
cd "$(dirname "$0")"

ORT_DIR="${ORT_DIR:-$HOME/.local/share/onnxruntime/onnxruntime-linux-x64-1.31.1/lib}"
# The system GCC's own headers (the same value every time, or cargo rebuilds the bindings).
GCC_INCLUDE="/usr/lib/gcc/x86_64-linux-gnu/$(gcc -dumpversion)/include"

export CMAKE_C_FLAGS_RELWITHDEBINFO="-O2 -DNDEBUG"
export CMAKE_CXX_FLAGS_RELWITHDEBINFO="-O2 -DNDEBUG"
export CMAKE_C_FLAGS_RELEASE="-O2 -DNDEBUG"
export CMAKE_CXX_FLAGS_RELEASE="-O2 -DNDEBUG"
export BINDGEN_EXTRA_CLANG_ARGS="-I$GCC_INCLUDE"
export ORT_LIB_LOCATION="$ORT_DIR"
export ORT_PREFER_DYNAMIC_LINK=1
export LD_LIBRARY_PATH="$ORT_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

exec npm run app "$@"
