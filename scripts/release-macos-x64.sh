#!/usr/bin/env bash

# Build the separate native package for Intel Macs. Run this on a macOS x86_64
# runner or an Intel Mac with x64 Node, Python and dependencies installed.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ULTRON_ARCH=x64 exec "${SCRIPT_DIR}/release-macos.sh" "$@"
