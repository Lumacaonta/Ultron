#!/usr/bin/env bash

# Build a macOS ULTRON package from a clean local checkout. The generated
# frontend and backend resources stay ignored by Git and never include .env.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-${PROJECT_ROOT}/backend/.venv/bin/python}"
FRONTEND_SOURCE="${PROJECT_ROOT}/frontend/dist"
FRONTEND_TARGET="${PROJECT_ROOT}/desktop/resources/frontend"
BACKEND_SOURCE="${PROJECT_ROOT}/backend/dist/ultron-backend"
BACKEND_TARGET_DIR="${PROJECT_ROOT}/desktop/resources/backend"
ELECTRON_ARCH="${ULTRON_ARCH:-}"
CODESIGN_IDENTITY="${ULTRON_CODESIGN_IDENTITY:--}"
NOTARIZE="${ULTRON_NOTARIZE:-0}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'scripts/build-macos.sh must run on macOS.\n' >&2
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

for command in npm rsync; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "${command}" >&2
    exit 1
  fi
done

if [[ ! -d "${PROJECT_ROOT}/frontend/node_modules" || ! -d "${PROJECT_ROOT}/desktop/node_modules" ]]; then
  printf 'Node dependencies are missing. Run scripts/bootstrap.sh first.\n' >&2
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

install -m 755 "${BACKEND_SOURCE}" "${BACKEND_TARGET_DIR}/ultron-backend"

# Keep the two otherwise-empty resource folders represented in source control
# without allowing a generated bundle to be committed.
touch "${FRONTEND_TARGET}/.gitkeep" "${BACKEND_TARGET_DIR}/.gitkeep"

if [[ -n "${ELECTRON_ARCH}" ]]; then
  npm --prefix "${PROJECT_ROOT}/desktop" run package -- "--arch=${ELECTRON_ARCH}"
else
  npm --prefix "${PROJECT_ROOT}/desktop" run package
fi

PACKAGE_APP="$(find "${PROJECT_ROOT}/desktop/out" -maxdepth 2 -type d -name 'ULTRON ai.app' -print -quit)"

if [[ -z "${PACKAGE_APP}" ]]; then
  printf 'Electron packaging did not create ULTRON ai.app.\n' >&2
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

printf 'macOS package created under desktop/out/.\n'
if [[ "${CODESIGN_IDENTITY}" == "-" ]]; then
  printf 'This is an ad-hoc signed preview. Use a Developer ID identity and notarization before calling it an official public binary.\n'
else
  printf 'Developer ID package signed successfully.\n'
fi
