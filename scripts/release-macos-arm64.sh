#!/usr/bin/env bash

# Build, structurally verify and archive ULTRON for Apple Silicon. This script
# intentionally refuses cross-compilation: both Electron and PyInstaller must
# be built on Apple Silicon for the released backend to be arm64 too.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ARCH="${ULTRON_ARCH:-arm64}"
RELEASE_DIR="${ULTRON_RELEASE_DIR:-${PROJECT_ROOT}/desktop/release}"
NOTARIZE="${ULTRON_NOTARIZE:-0}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'scripts/release-macos-arm64.sh must run on macOS.\n' >&2
  exit 1
fi

if [[ "${ARCH}" != "arm64" ]]; then
  printf 'This release script only builds arm64. Received: %s\n' "${ARCH}" >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  printf 'This release script must run natively on an Apple Silicon Mac (uname -m: %s).\n' "$(uname -m)" >&2
  exit 1
fi

rm -rf -- "${RELEASE_DIR}"
mkdir -p "${RELEASE_DIR}"

ULTRON_ARCH="${ARCH}" "${SCRIPT_DIR}/build-macos.sh"

PACKAGE_APP="${PROJECT_ROOT}/desktop/out/ULTRON ai-darwin-arm64/ULTRON ai.app"
"${SCRIPT_DIR}/verify-release.sh" "${PACKAGE_APP}"

if [[ "${NOTARIZE}" == "1" ]]; then
  spctl --assess --type execute --verbose=4 "${PACKAGE_APP}"
fi

VERSION="$(plutil -extract CFBundleShortVersionString raw "${PACKAGE_APP}/Contents/Info.plist")"
ZIP_ARCHIVE="${RELEASE_DIR}/ULTRON-ai-${VERSION}-macos-${ARCH}.zip"
ZIP_CHECKSUM="${ZIP_ARCHIVE}.sha256"
DMG_ARCHIVE="${RELEASE_DIR}/ULTRON-ai-${VERSION}-macos-${ARCH}.dmg"
DMG_CHECKSUM="${DMG_ARCHIVE}.sha256"
CHECKSUM_MANIFEST="${RELEASE_DIR}/ULTRON-ai-${VERSION}-macos-${ARCH}-SHA256SUMS.txt"

ditto -c -k --sequesterRsrc --keepParent "${PACKAGE_APP}" "${ZIP_ARCHIVE}"
"${SCRIPT_DIR}/create-macos-dmg.sh" "${PACKAGE_APP}" "${DMG_ARCHIVE}"

if [[ "${NOTARIZE}" == "1" ]]; then
  "${SCRIPT_DIR}/notarize-macos-dmg.sh" "${DMG_ARCHIVE}"
  spctl --assess --type open --verbose=4 "${DMG_ARCHIVE}"
fi

"${SCRIPT_DIR}/verify-macos-dmg.sh" "${DMG_ARCHIVE}"

(
  cd "${RELEASE_DIR}"
  shasum -a 256 "$(basename "${ZIP_ARCHIVE}")" > "$(basename "${ZIP_CHECKSUM}")"
  shasum -a 256 "$(basename "${DMG_ARCHIVE}")" > "$(basename "${DMG_CHECKSUM}")"
  cat "$(basename "${ZIP_CHECKSUM}")" "$(basename "${DMG_CHECKSUM}")" \
    > "$(basename "${CHECKSUM_MANIFEST}")"
)

printf 'Release installer: %s\n' "${DMG_ARCHIVE}"
printf 'Release archive: %s\n' "${ZIP_ARCHIVE}"
printf 'Checksums: %s\n' "${CHECKSUM_MANIFEST}"
