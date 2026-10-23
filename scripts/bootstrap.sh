#!/usr/bin/env bash

# Prepare a local ULTRON development checkout without creating or copying
# secrets. Run this once after cloning, then configure backend/.env as needed.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="${PROJECT_ROOT}/backend/.venv"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  printf 'Python was not found. Set PYTHON_BIN or install Python 3.11+.\n' >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  printf 'npm was not found. Install Node.js 22.13+ and run this script again.\n' >&2
  exit 1
fi

node - <<'NODE_CHECK'
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(`ULTRON requires Node.js 22.13 or later. Found ${process.versions.node}.\n`)
  process.exit(1)
}
NODE_CHECK

"${PYTHON_BIN}" - <<'PYTHON_CHECK'
import sys
if sys.version_info < (3, 11):
    raise SystemExit('ULTRON requires Python 3.11 or later.')
PYTHON_CHECK

if [[ ! -f "${PROJECT_ROOT}/backend/.env" ]]; then
  cp "${PROJECT_ROOT}/backend/.env.example" "${PROJECT_ROOT}/backend/.env"
  printf 'Created backend/.env from the safe example. Review it before use.\n'
fi

"${PYTHON_BIN}" -m venv "${VENV_DIR}"
"${VENV_DIR}/bin/python" -m pip install --upgrade pip
"${VENV_DIR}/bin/python" -m pip install -r "${PROJECT_ROOT}/requirements.txt"

install_node_dependencies() {
  local directory="$1"

  if [[ -f "${directory}/package-lock.json" ]]; then
    npm --prefix "${directory}" ci
  else
    npm --prefix "${directory}" install
  fi
}

install_node_dependencies "${PROJECT_ROOT}/frontend"
install_node_dependencies "${PROJECT_ROOT}/desktop"

printf 'ULTRON dependencies are ready. Start the backend with backend/.venv/bin/python backend/launcher.py.\n'
