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

APP_PATH="$MOUNT_POINT/ULTRON ai.app"
if [[ ! -d "$APP_PATH" ]]; then
  printf 'Installer does not contain ULTRON ai.app.\n' >&2
  exit 1
fi

if [[ ! -L "$MOUNT_POINT/Applications" ]] ||
  [[ "$(readlink "$MOUNT_POINT/Applications")" != '/Applications' ]]; then
  printf 'Installer does not expose the Applications shortcut.\n' >&2
  exit 1
fi

if [[ ! -f "$MOUNT_POINT/START HERE.txt" ]] ||
  ! rg -Fq 'Drag ULTRON ai.app' "$MOUNT_POINT/START HERE.txt"; then
  printf 'Installer guide is missing or incomplete.\n' >&2
  exit 1
fi

codesign --verify --deep --strict "$APP_PATH"

bundle_id="$(plutil -extract CFBundleIdentifier raw "$APP_PATH/Contents/Info.plist")"
if [[ "$bundle_id" != 'io.ultronai.desktop' ]]; then
  printf 'Unexpected bundle identifier in installer: %s\n' "$bundle_id" >&2
  exit 1
fi

hdiutil detach "$DEVICE" -quiet
DEVICE=''

printf 'ULTRON macOS installer verified: %s\n' "$DMG_PATH"
