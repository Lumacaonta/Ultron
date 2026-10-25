#!/usr/bin/env bash

# Compatibility entry point for Apple Silicon releases.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ULTRON_ARCH=arm64 exec "${SCRIPT_DIR}/release-macos.sh" "$@"
