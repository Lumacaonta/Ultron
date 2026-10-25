#!/usr/bin/env bash

# Build, verify and archive one native macOS ULTRON release. Wrappers select
# arm64 or x64 so a release never accidentally combines an Electron executable
# with a backend compiled for another CPU architecture.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ARCH="${ULTRON_ARCH:-}"
RELEASE_DIR="${ULTRON_RELEASE_DIR:-${PROJECT_ROOT}/desktop/release}"
NOTARIZE="${ULTRON_NOTARIZE:-0}"
PYTHON_BIN="${PYTHON_BIN:-${PROJECT_ROOT}/backend/.venv/bin/python}"

case "${ARCH}" in
  arm64)
    TARGET_MACHINE='arm64'
    ;;
  x64)
    TARGET_MACHINE='x86_64'
    ;;
  *)
    printf 'ULTRON_ARCH must be arm64 or x64. Received: %s\n' "${ARCH}" >&2
    exit 1
    ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'scripts/release-macos.sh must run on macOS.\n' >&2
  exit 1
fi

if [[ "$(uname -m)" != "${TARGET_MACHINE}" ]]; then
  printf 'The macOS %s release must run in a native %s environment. Current process architecture: %s.\n' \
    "${ARCH}" "${TARGET_MACHINE}" "$(uname -m)" >&2
  exit 1
fi

if [[ ! -x "${PYTHON_BIN}" ]]; then
  printf 'Python environment not found. Run scripts/bootstrap.sh first.\n' >&2
  exit 1
fi

for command in node ditto hdiutil codesign plutil shasum; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "${command}" >&2
    exit 1
  fi
done

PYTHON_MACHINE="$("${PYTHON_BIN}" -c 'import platform; print(platform.machine())')"
NODE_ARCH="$(node -p 'process.arch')"
if [[ "${PYTHON_MACHINE}" != "${TARGET_MACHINE}" || "${NODE_ARCH}" != "${ARCH}" ]]; then
  printf 'The release needs %s Python and %s Node. Found Python %s and Node %s.\n' \
    "${TARGET_MACHINE}" "${ARCH}" "${PYTHON_MACHINE}" "${NODE_ARCH}" >&2
  exit 1
fi

mkdir -p "${RELEASE_DIR}"

# Keep the other native architecture's artifacts in the shared release folder.
# A new Intel build must not erase a verified Apple Silicon download (and vice
# versa), while stale files for the target architecture must never be reused.
find "${RELEASE_DIR}" -maxdepth 1 -type f \
  -name "ULTRON-ai-*-macos-${ARCH}*" -delete

ULTRON_ARCH="${ARCH}" PYTHON_BIN="${PYTHON_BIN}" "${SCRIPT_DIR}/build-macos.sh"

PACKAGE_APP="${PROJECT_ROOT}/desktop/out/ULTRON ai-darwin-${ARCH}/ULTRON ai.app"
ULTRON_ARCH="${ARCH}" "${SCRIPT_DIR}/verify-release.sh" "${PACKAGE_APP}"

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

ULTRON_ARCH="${ARCH}" "${SCRIPT_DIR}/verify-macos-dmg.sh" "${DMG_ARCHIVE}"

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
