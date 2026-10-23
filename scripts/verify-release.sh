#!/usr/bin/env bash

# Validate a completed macOS package without reading a developer's private
# .env, account data, vault, or Mail configuration.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_APP="${PROJECT_ROOT}/desktop/out/ULTRON ai-darwin-arm64/ULTRON ai.app"
PACKAGE_APP="${1:-${DEFAULT_APP}}"
ASAR_TOOL="${PROJECT_ROOT}/desktop/node_modules/.bin/asar"

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'scripts/verify-release.sh must run on macOS.\n' >&2
  exit 1
fi

if [[ ! -d "${PACKAGE_APP}" ]]; then
  printf 'Package not found: %s\n' "${PACKAGE_APP}" >&2
  exit 1
fi

if [[ ! -x "${ASAR_TOOL}" ]]; then
  printf 'The desktop dependencies are missing. Run scripts/bootstrap.sh first.\n' >&2
  exit 1
fi

APP_ASAR="${PACKAGE_APP}/Contents/Resources/app.asar"
if [[ ! -f "${APP_ASAR}" ]]; then
  printf 'app.asar is missing from the package.\n' >&2
  exit 1
fi

codesign --verify --deep --strict "${PACKAGE_APP}"

bundle_id="$(plutil -extract CFBundleIdentifier raw "${PACKAGE_APP}/Contents/Info.plist")"
version="$(plutil -extract CFBundleShortVersionString raw "${PACKAGE_APP}/Contents/Info.plist")"
app_category="$(plutil -extract LSApplicationCategoryType raw "${PACKAGE_APP}/Contents/Info.plist" || true)"
microphone_usage="$(plutil -extract NSMicrophoneUsageDescription raw "${PACKAGE_APP}/Contents/Info.plist" || true)"
expected_version="$(
  node -e 'process.stdout.write(require(process.argv[1]).version)' \
    "${PROJECT_ROOT}/desktop/package.json"
)"

if [[ "${bundle_id}" != "io.ultronai.desktop" ]]; then
  printf 'Unexpected bundle identifier: %s\n' "${bundle_id}" >&2
  exit 1
fi

if [[ "${version}" != "${expected_version}" ]]; then
  printf 'Unexpected package version: %s (expected %s)\n' \
    "${version}" "${expected_version}" >&2
  exit 1
fi

if [[ "${app_category}" != 'public.app-category.productivity' ]]; then
  printf 'Unexpected application category: %s\n' "${app_category}" >&2
  exit 1
fi

if [[ -z "${microphone_usage}" ]]; then
  printf 'The packaged app is missing its microphone permission explanation.\n' >&2
  exit 1
fi

for forbidden_permission in \
  NSCameraUsageDescription \
  NSAudioCaptureUsageDescription \
  NSBluetoothAlwaysUsageDescription \
  NSBluetoothPeripheralUsageDescription; do
  if plutil -extract "${forbidden_permission}" raw \
    "${PACKAGE_APP}/Contents/Info.plist" >/dev/null 2>&1; then
    printf 'The packaged app declares an unused permission: %s\n' \
      "${forbidden_permission}" >&2
    exit 1
  fi
done

arbitrary_loads="$(
  plutil -extract NSAppTransportSecurity.NSAllowsArbitraryLoads raw \
    "${PACKAGE_APP}/Contents/Info.plist" 2>/dev/null || true
)"
if [[ "${arbitrary_loads}" != 'false' ]]; then
  printf 'The packaged app must disable arbitrary network loads.\n' >&2
  exit 1
fi

for executable in \
  "${PACKAGE_APP}/Contents/MacOS/ULTRON ai" \
  "${PACKAGE_APP}/Contents/Resources/backend/ultron-backend"; do
  if [[ ! -x "${executable}" ]]; then
    printf 'Required arm64 executable is missing: %s\n' "${executable}" >&2
    exit 1
  fi
  if ! lipo -archs "${executable}" | tr ' ' '\n' | rg -x 'arm64' >/dev/null; then
    printf 'Required executable does not include arm64: %s\n' "${executable}" >&2
    exit 1
  fi
done

if "${ASAR_TOOL}" list "${APP_ASAR}" | rg -i '(backup|before-|\.env($|/)|\.db($|/)|auth\.secret|node_modules|resources|assets|release($|/)|forge\.config|ultron\.png)'; then
  printf 'The application archive contains an excluded release artifact.\n' >&2
  exit 1
fi

private_resource="$(find "${PACKAGE_APP}/Contents/Resources" -type f \
  \( -name '.env' -o -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \
     -o -name 'auth.secret' -o -name 'backend.log' \) -print -quit)"
if [[ -n "${private_resource}" ]]; then
  printf 'The package resources contain private runtime data.\n' >&2
  exit 1
fi

# A developer can safely build from a working folder that has a local .env,
# but no non-empty credential value from that file may end up in the bundled
# backend.  Print only setting names if this guard ever catches a leak.
PACKAGED_BACKEND="${PACKAGE_APP}/Contents/Resources/backend/ultron-backend"
LOCAL_ENV="${PROJECT_ROOT}/backend/.env"
if [[ -x "${PACKAGED_BACKEND}" && -f "${LOCAL_ENV}" ]]; then
  python3 - "${PACKAGED_BACKEND}" "${LOCAL_ENV}" <<'PYTHON'
import re
import sys
from pathlib import Path

artifact = Path(sys.argv[1]).read_bytes()
leaked_names = []
for raw_line in Path(sys.argv[2]).read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    name, value = line.split("=", 1)
    value = value.strip().strip('"').strip("'")
    if (
        re.search(r"(?:KEY|SECRET|PASSWORD|TOKEN)$", name.strip(), re.I)
        and len(value) >= 12
        and value.encode("utf-8") in artifact
    ):
        leaked_names.append(name.strip())

if leaked_names:
    print(
        "The bundled backend contains local credential values for: "
        + ", ".join(leaked_names),
        file=sys.stderr,
    )
    raise SystemExit(1)
PYTHON
fi

resource_differences="$(diff -qr "${PROJECT_ROOT}/frontend/dist" "${PACKAGE_APP}/Contents/Resources/frontend" | rg -v '\.gitkeep$' || true)"
if [[ -n "${resource_differences}" ]]; then
  printf 'Packaged frontend files do not match the current frontend build.\n' >&2
  printf '%s\n' "${resource_differences}" >&2
  exit 1
fi

if rg -n -i '/Users/|/home/|C:\\Users\\' \
  "${PROJECT_ROOT}/frontend/dist" \
  "${PACKAGE_APP}/Contents/Resources/frontend"; then
  printf 'A personal value was found in generated frontend resources.\n' >&2
  exit 1
fi

printf 'ULTRON release package verified: %s (%s)\n' "${bundle_id}" "${version}"
