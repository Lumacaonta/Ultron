#!/usr/bin/env bash

# Apple notarizes the app bundle during Forge packaging. The downloadable DMG
# is a second signed artifact, so submit and staple it before a final release.
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  printf 'Usage: %s <installer.dmg>\n' "$0" >&2
  exit 1
fi

DMG_PATH="$1"

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'scripts/notarize-macos-dmg.sh must run on macOS.\n' >&2
  exit 1
fi

if [[ ! -f "$DMG_PATH" ]]; then
  printf 'DMG not found: %s\n' "$DMG_PATH" >&2
  exit 1
fi

for variable_name in \
  ULTRON_APPLE_ID \
  ULTRON_APPLE_APP_SPECIFIC_PASSWORD \
  ULTRON_APPLE_TEAM_ID; do
  if [[ -z "${!variable_name:-}" ]]; then
    printf 'Missing required notarization variable: %s\n' "$variable_name" >&2
    exit 1
  fi
done

xcrun notarytool submit "$DMG_PATH" \
  --apple-id "$ULTRON_APPLE_ID" \
  --password "$ULTRON_APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$ULTRON_APPLE_TEAM_ID" \
  --wait

xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"

printf 'macOS installer notarized and stapled: %s\n' "$DMG_PATH"
