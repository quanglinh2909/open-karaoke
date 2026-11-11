#!/usr/bin/env bash
# Starts Open Karaoke in development mode (tauri dev) with the build
# environment Ubuntu 22.04 needs (scripts/linux-build-env.sh).
# Run it from any directory: ./run-app.sh
set -e
cd "$(dirname "$0")"
. scripts/linux-build-env.sh
exec npm run app "$@"
