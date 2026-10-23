#!/usr/bin/env bash

# Create the standard macOS drag-to-Applications installer. Keeping this step
# outside Electron Forge makes the contents explicit and lets the release
# process produce both a convenient DMG and a portable ZIP from the same app.
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  printf 'Usage: %s <ULTRON ai.app> <output.dmg>\n' "$0" >&2
  exit 1
fi

APP_PATH="$1"
OUTPUT_PATH="$2"
VOLUME_NAME="${ULTRON_DMG_VOLUME_NAME:-Install ULTRON ai}"
CODESIGN_IDENTITY="${ULTRON_CODESIGN_IDENTITY:--}"
WORK_DIR=''

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'scripts/create-macos-dmg.sh must run on macOS.\n' >&2
  exit 1
fi

if [[ ! -d "$APP_PATH" ]]; then
  printf 'Application bundle not found: %s\n' "$APP_PATH" >&2
  exit 1
fi

if [[ ! -f "$APP_PATH/Contents/Info.plist" ]]; then
  printf 'Not a macOS application bundle: %s\n' "$APP_PATH" >&2
  exit 1
fi

cleanup() {
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf -- "$WORK_DIR"
  fi
}
trap cleanup EXIT

mkdir -p "$(dirname -- "$OUTPUT_PATH")"
rm -f -- "$OUTPUT_PATH"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ultron-dmg.XXXXXX")"
STAGING_ROOT="$WORK_DIR/payload"
mkdir -p "$STAGING_ROOT"

# ditto preserves the bundle's signing metadata while copying its resources.
ditto "$APP_PATH" "$STAGING_ROOT/ULTRON ai.app"
ln -s /Applications "$STAGING_ROOT/Applications"

cat > "$STAGING_ROOT/START HERE.txt" <<'INSTALL_GUIDE'
ULTRON for macOS

1. Drag ULTRON ai.app onto the Applications folder in this window.
2. Open ULTRON from Applications.
3. Complete the short first-launch guide to connect only the features you use.

ULTRON keeps its account profiles, memory and optional integrations on this Mac.
INSTALL_GUIDE

create_disk_image() {
  hdiutil create \
    -volname "$VOLUME_NAME" \
    -srcfolder "$STAGING_ROOT" \
    -ov \
    -format UDZO \
    -imagekey zlib-level=9 \
    "$OUTPUT_PATH"
}

# macOS can briefly keep a disk-image helper busy after another image finishes.
# Retry the isolated image creation so a transient host condition cannot make a
# clean source build look broken.
for attempt in 1 2 3; do
  rm -f -- "$OUTPUT_PATH"
  if create_disk_image; then
    break
  fi
  if [[ "$attempt" == 3 ]]; then
    printf 'Could not create the DMG after %s attempts.\n' "$attempt" >&2
    exit 1
  fi
  sleep "$attempt"
done

# The outer disk image is signed as well as the application it contains. A
# preview uses an ad-hoc signature; a production build receives Developer ID.
codesign --force --sign "$CODESIGN_IDENTITY" "$OUTPUT_PATH"
codesign --verify --strict "$OUTPUT_PATH"
hdiutil verify "$OUTPUT_PATH"

printf 'macOS installer DMG created: %s\n' "$OUTPUT_PATH"
