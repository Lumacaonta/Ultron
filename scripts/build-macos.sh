#!/usr/bin/env bash

# Build a macOS ULTRON package from a clean local checkout. The Electron shell
# and the PyInstaller backend must be built by a process of the target CPU
# architecture: Electron Forge can download another Electron architecture, but
# PyInstaller cannot cross-compile the local core safely.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-${PROJECT_ROOT}/backend/.venv/bin/python}"
FRONTEND_SOURCE="${PROJECT_ROOT}/frontend/dist"
FRONTEND_TARGET="${PROJECT_ROOT}/desktop/resources/frontend"
BACKEND_SOURCE="${PROJECT_ROOT}/backend/dist/ultron-backend"
BACKEND_TARGET_DIR="${PROJECT_ROOT}/desktop/resources/backend"
REQUESTED_ARCH="${ULTRON_ARCH:-}"
CODESIGN_IDENTITY="${ULTRON_CODESIGN_IDENTITY:--}"
NOTARIZE="${ULTRON_NOTARIZE:-0}"

normalize_arch() {
  case "$1" in
    arm64)
      printf 'arm64\n'
      ;;
    x64|x86_64)
      printf 'x64\n'
      ;;
    *)
      return 1
      ;;
  esac
}

machine_for_arch() {
  case "$1" in
    arm64)
      printf 'arm64\n'
      ;;
    x64)
      printf 'x86_64\n'
      ;;
    *)
      return 1
      ;;
  esac
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'scripts/build-macos.sh must run on macOS.\n' >&2
  exit 1
fi

if [[ -z "${REQUESTED_ARCH}" ]]; then
  REQUESTED_ARCH="$(uname -m)"
fi

if ! ELECTRON_ARCH="$(normalize_arch "${REQUESTED_ARCH}")"; then
  printf 'ULTRON_ARCH must be arm64 or x64. Received: %s\n' \
    "${REQUESTED_ARCH}" >&2
  exit 1
fi

TARGET_MACHINE="$(machine_for_arch "${ELECTRON_ARCH}")"
RUNTIME_MACHINE="$(uname -m)"

if [[ "${RUNTIME_MACHINE}" != "${TARGET_MACHINE}" ]]; then
  printf 'A macOS %s package needs a native %s Node and Python toolchain. ' \
    "${ELECTRON_ARCH}" "${TARGET_MACHINE}" >&2
  printf 'Current process architecture: %s.\n' "${RUNTIME_MACHINE}" >&2
  exit 1
fi

if [[ "${NOTARIZE}" == "1" && "${CODESIGN_IDENTITY}" == "-" ]]; then
  printf 'ULTRON_NOTARIZE=1 requires a Developer ID signing identity.\n' >&2
  exit 1
fi

if [[ ! -x "${PYTHON_BIN}" ]]; then
  printf 'Python environment not found. Run scripts/bootstrap.sh first.\n' >&2
  exit 1
fi

for command in npm node rsync lipo; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "${command}" >&2
    exit 1
  fi
done

if [[ ! -d "${PROJECT_ROOT}/frontend/node_modules" || ! -d "${PROJECT_ROOT}/desktop/node_modules" ]]; then
  printf 'Node dependencies are missing. Run scripts/bootstrap.sh first.\n' >&2
  exit 1
fi

PYTHON_MACHINE="$("${PYTHON_BIN}" -c 'import platform; print(platform.machine())')"
NODE_ARCH="$(node -p 'process.arch')"
if [[ "${PYTHON_MACHINE}" != "${TARGET_MACHINE}" ]]; then
  printf 'PYTHON_BIN is %s, but the %s build requires %s.\n' \
    "${PYTHON_MACHINE}" "${ELECTRON_ARCH}" "${TARGET_MACHINE}" >&2
  exit 1
fi

if [[ "${NODE_ARCH}" != "${ELECTRON_ARCH}" ]]; then
  printf 'Node.js is %s, but the macOS build requires %s.\n' \
    "${NODE_ARCH}" "${ELECTRON_ARCH}" >&2
  exit 1
fi

# Never package leftovers from a prior developer build. The resources folders
# are recreated from current sources and Electron Forge recreates its output.
rm -rf -- "${FRONTEND_TARGET}" "${BACKEND_TARGET_DIR}" "${PROJECT_ROOT}/desktop/out"
mkdir -p "${FRONTEND_TARGET}" "${BACKEND_TARGET_DIR}"

npm --prefix "${PROJECT_ROOT}/frontend" run build
rsync -a --delete "${FRONTEND_SOURCE}/" "${FRONTEND_TARGET}/"

(
  cd "${PROJECT_ROOT}/backend"
  "${PYTHON_BIN}" -m PyInstaller --noconfirm --clean ultron-backend.spec
)

if [[ ! -f "${BACKEND_SOURCE}" ]]; then
  printf 'The backend bundle was not created at %s\n' "${BACKEND_SOURCE}" >&2
  exit 1
fi

if ! lipo -archs "${BACKEND_SOURCE}" | tr ' ' '\n' | grep -Fxq "${TARGET_MACHINE}"; then
  printf 'The generated backend does not include %s: %s\n' \
    "${TARGET_MACHINE}" "${BACKEND_SOURCE}" >&2
  exit 1
fi

install -m 755 "${BACKEND_SOURCE}" "${BACKEND_TARGET_DIR}/ultron-backend"

# Keep the two otherwise-empty resource folders represented in source control
# without allowing a generated bundle to be committed.
touch "${FRONTEND_TARGET}/.gitkeep" "${BACKEND_TARGET_DIR}/.gitkeep"

npm --prefix "${PROJECT_ROOT}/desktop" run package -- "--arch=${ELECTRON_ARCH}"

PACKAGE_APP="${PROJECT_ROOT}/desktop/out/Ultron AI-darwin-${ELECTRON_ARCH}/Ultron AI.app"

if [[ ! -d "${PACKAGE_APP}" ]]; then
  printf 'Electron packaging did not create %s.\n' "${PACKAGE_APP}" >&2
  exit 1
fi

APP_EXECUTABLE="${PACKAGE_APP}/Contents/MacOS/Ultron AI"
if ! lipo -archs "${APP_EXECUTABLE}" | tr ' ' '\n' | grep -Fxq "${TARGET_MACHINE}"; then
  printf 'The Electron executable does not include %s: %s\n' \
    "${TARGET_MACHINE}" "${APP_EXECUTABLE}" >&2
  exit 1
fi

# Electron Forge owns production signing and notarization when a Developer ID
# identity is supplied. A preview build uses an ad-hoc signature only so its
# structure can still be verified locally.
if [[ "${CODESIGN_IDENTITY}" == "-" ]]; then
  codesign --force --deep --sign - "${PACKAGE_APP}"
fi

codesign --verify --deep --strict "${PACKAGE_APP}"

if [[ "${NOTARIZE}" == "1" ]]; then
  xcrun stapler staple "${PACKAGE_APP}"
  xcrun stapler validate "${PACKAGE_APP}"
fi

printf 'macOS %s package created under desktop/out/.\n' "${ELECTRON_ARCH}"
if [[ "${CODESIGN_IDENTITY}" == "-" ]]; then
  printf 'This is an ad-hoc signed preview. Use a Developer ID identity and notarization before calling it an official public binary.\n'
else
  printf 'Developer ID package signed successfully.\n'
fi
