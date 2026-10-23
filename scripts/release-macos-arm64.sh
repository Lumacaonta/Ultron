#!/usr/bin/env bash

# Build, structurally verify and archive ULTRON for Apple Silicon. This script
# intentionally refuses cross-compilation: both Electron and PyInstaller must
# be built on Apple Silicon for the released backend to be arm64 too.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ARCH="${ULTRON_ARCH:-arm64}"
RELEASE_DIR="${ULTRON_RELEASE_DIR:-${PROJECT_ROOT}/desktop/release}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'scripts/release-macos-arm64.sh must run on macOS.\n' >&2
  exit 1
fi

if [[ "${ARCH}" != "arm64" ]]; then
  printf 'This release script only builds arm64. Received: %s\n' "${ARCH}" >&2
  exit 1
fi

rm -rf -- "${RELEASE_DIR}"
mkdir -p "${RELEASE_DIR}"

ULTRON_ARCH="${ARCH}" "${SCRIPT_DIR}/build-macos.sh"

PACKAGE_APP="${PROJECT_ROOT}/desktop/out/ULTRON ai-darwin-arm64/ULTRON ai.app"
"${SCRIPT_DIR}/verify-release.sh" "${PACKAGE_APP}"

if [[ "${ULTRON_NOTARIZE:-0}" == "1" ]]; then
  spctl --assess --type execute --verbose=4 "${PACKAGE_APP}"
fi

VERSION="$(plutil -extract CFBundleShortVersionString raw "${PACKAGE_APP}/Contents/Info.plist")"
ARCHIVE="${RELEASE_DIR}/ULTRON-ai-${VERSION}-macos-${ARCH}.zip"
CHECKSUM="${ARCHIVE}.sha256"

ditto -c -k --sequesterRsrc --keepParent "${PACKAGE_APP}" "${ARCHIVE}"
(
  cd "${RELEASE_DIR}"
  shasum -a 256 "$(basename "${ARCHIVE}")" > "$(basename "${CHECKSUM}")"
)

printf 'Release archive: %s\n' "${ARCHIVE}"
printf 'SHA-256: %s\n' "${CHECKSUM}"
