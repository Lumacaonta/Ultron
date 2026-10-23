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

if [[ "${bundle_id}" != "io.ultronai.desktop" ]]; then
  printf 'Unexpected bundle identifier: %s\n' "${bundle_id}" >&2
  exit 1
fi

if [[ "${version}" != "1.0.0" ]]; then
  printf 'Unexpected package version: %s\n' "${version}" >&2
  exit 1
fi

if "${ASAR_TOOL}" list "${APP_ASAR}" | rg -i '(backup|before-|\.env($|/)|\.db($|/)|auth\.secret|node_modules|resources|assets|forge\.config|ultron\.png)'; then
  printf 'The application archive contains an excluded release artifact.\n' >&2
  exit 1
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
