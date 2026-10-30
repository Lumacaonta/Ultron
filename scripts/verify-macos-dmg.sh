#!/usr/bin/env bash

# Check a finished installer exactly as a person receives it: validate the
# image, mount it read-only, inspect the installation path and verify the app.
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  printf 'Usage: %s <installer.dmg>\n' "$0" >&2
  exit 1
fi

DMG_PATH="$1"
ATTACH_INFO=''
DEVICE=''
REQUESTED_ARCH="${ULTRON_ARCH:-}"
ARCH=''
TARGET_MACHINE=''

if [[ -n "${REQUESTED_ARCH}" ]]; then
  case "${REQUESTED_ARCH}" in
    arm64)
      ARCH='arm64'
      TARGET_MACHINE='arm64'
      ;;
    x64|x86_64)
      ARCH='x64'
      TARGET_MACHINE='x86_64'
      ;;
    *)
      printf 'ULTRON_ARCH must be arm64 or x64. Received: %s\n' \
        "${REQUESTED_ARCH}" >&2
      exit 1
      ;;
  esac
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'scripts/verify-macos-dmg.sh must run on macOS.\n' >&2
  exit 1
fi

if [[ ! -f "$DMG_PATH" ]]; then
  printf 'DMG not found: %s\n' "$DMG_PATH" >&2
  exit 1
fi

cleanup() {
  if [[ -n "$DEVICE" ]]; then
    hdiutil detach "$DEVICE" -quiet || true
  fi
  if [[ -n "$ATTACH_INFO" && -f "$ATTACH_INFO" ]]; then
    rm -f -- "$ATTACH_INFO"
  fi
}
trap cleanup EXIT

hdiutil verify "$DMG_PATH"
codesign --verify --strict "$DMG_PATH"

ATTACH_INFO="$(mktemp "${TMPDIR:-/tmp}/ultron-dmg-info.XXXXXX")"
hdiutil attach -nobrowse -readonly -plist "$DMG_PATH" > "$ATTACH_INFO"

DEVICE="$(python3 - "$ATTACH_INFO" <<'PYTHON'
import plistlib
import sys

with open(sys.argv[1], 'rb') as stream:
    payload = plistlib.load(stream)

for entity in payload.get('system-entities', []):
    if 'mount-point' in entity:
        print(entity['dev-entry'])
        break
else:
    raise SystemExit('No mounted volume was returned by hdiutil.')
PYTHON
)"

MOUNT_POINT="$(python3 - "$ATTACH_INFO" <<'PYTHON'
import plistlib
import sys

with open(sys.argv[1], 'rb') as stream:
    payload = plistlib.load(stream)

for entity in payload.get('system-entities', []):
    if 'mount-point' in entity:
        print(entity['mount-point'])
        break
else:
    raise SystemExit('No mounted volume was returned by hdiutil.')
PYTHON
)"

APP_PATH="$MOUNT_POINT/Ultron AI.app"
if [[ ! -d "$APP_PATH" ]]; then
  printf 'Installer does not contain Ultron AI.app.\n' >&2
  exit 1
fi

if [[ ! -L "$MOUNT_POINT/Applications" ]] ||
  [[ "$(readlink "$MOUNT_POINT/Applications")" != '/Applications' ]]; then
  printf 'Installer does not expose the Applications shortcut.\n' >&2
  exit 1
fi

if [[ ! -f "$MOUNT_POINT/START HERE.txt" ]] ||
  ! grep -Fq 'Drag Ultron AI.app' "$MOUNT_POINT/START HERE.txt"; then
  printf 'Installer guide is missing or incomplete.\n' >&2
  exit 1
fi

codesign --verify --deep --strict "$APP_PATH"

if [[ -n "${ARCH}" ]]; then
  for executable in \
    "$APP_PATH/Contents/MacOS/Ultron AI" \
    "$APP_PATH/Contents/Resources/backend/ultron-backend"; do
    if [[ ! -x "${executable}" ]]; then
      printf 'Installer is missing its %s executable: %s\n' \
        "${ARCH}" "${executable}" >&2
      exit 1
    fi
    if ! lipo -archs "${executable}" | tr ' ' '\n' | grep -Fxq "${TARGET_MACHINE}"; then
      printf 'Installer executable does not include %s: %s\n' \
        "${TARGET_MACHINE}" "${executable}" >&2
      exit 1
    fi
  done
fi

bundle_id="$(plutil -extract CFBundleIdentifier raw "$APP_PATH/Contents/Info.plist")"
if [[ "$bundle_id" != 'io.ultronai.desktop' ]]; then
  printf 'Unexpected bundle identifier in installer: %s\n' "$bundle_id" >&2
  exit 1
fi

hdiutil detach "$DEVICE" -quiet
DEVICE=''

printf 'Ultron AI macOS installer verified: %s\n' "$DMG_PATH"
