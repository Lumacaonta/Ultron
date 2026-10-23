# macOS release guide

ULTRON's source is public and checks for private files before every release.
A public macOS app is a separate deliverable: it needs a platform-native build,
a signature and Apple notarization before it can be presented as an official
download.

See [platform support](PLATFORM_SUPPORT.md) for the rollout order: Apple
Silicon first, then Intel Mac, Windows and Linux.

## Build an Apple Silicon preview

Run this from a clean checkout on an Apple Silicon Mac:

~~~bash
./scripts/bootstrap.sh
./scripts/release-macos-arm64.sh
~~~

The script rebuilds the frontend and backend from source, creates an arm64
Electron package, verifies its archive and writes:

~~~text
desktop/release/ULTRON-ai-<version>-macos-arm64.zip
desktop/release/ULTRON-ai-<version>-macos-arm64.zip.sha256
~~~

An ad-hoc signature is enough for the structural checks but is **not** an
Apple-trusted public signature. Do not describe that ZIP as notarized.

## Sign and notarize an official macOS build

ULTRON's Forge configuration enables Hardened Runtime and uses the minimal
entitlements in [desktop/entitlements.mac.plist](../desktop/entitlements.mac.plist)
when a Developer ID identity is supplied.

Use a **Developer ID Application** certificate owned by the release
maintainer, then provide Apple notarization credentials only through the local
environment or GitHub Actions secrets:

~~~bash
ULTRON_ARCH=arm64 \
ULTRON_CODESIGN_IDENTITY='Developer ID Application: Your Team Name (TEAMID)' \
ULTRON_NOTARIZE=1 \
ULTRON_APPLE_ID='maintainer@example.com' \
ULTRON_APPLE_APP_SPECIFIC_PASSWORD='app-specific-password' \
ULTRON_APPLE_TEAM_ID='TEAMID' \
./scripts/release-macos-arm64.sh
~~~

The script staples and validates the ticket, then runs Gatekeeper assessment:

~~~bash
codesign --verify --deep --strict \
  'desktop/out/ULTRON ai-darwin-arm64/ULTRON ai.app'

spctl --assess --type execute --verbose=4 \
  'desktop/out/ULTRON ai-darwin-arm64/ULTRON ai.app'
~~~

Publish only after both checks pass. Never store a certificate, Apple password,
notary profile, .env, vault, database or account data in the repository.

## GitHub Actions release

The repository contains a manually run **Publish signed macOS ARM64 release**
workflow. Configure these repository secrets before selecting
**notarize: true**:

| Secret | Purpose |
| --- | --- |
| ULTRON_MACOS_CERTIFICATE_BASE64 | Base64-encoded Developer ID .p12 certificate. |
| ULTRON_MACOS_CERTIFICATE_PASSWORD | Password for that certificate. |
| ULTRON_MACOS_KEYCHAIN_PASSWORD | Temporary CI keychain password. |
| ULTRON_CODESIGN_IDENTITY | Full Developer ID Application identity name. |
| ULTRON_APPLE_ID | Apple ID used for notarization. |
| ULTRON_APPLE_APP_SPECIFIC_PASSWORD | App-specific Apple ID password. |
| ULTRON_APPLE_TEAM_ID | Apple Developer Team ID. |

The workflow imports the certificate into a temporary keychain, builds directly
on an Apple Silicon macOS runner, verifies the finished app, publishes the ZIP
and its SHA-256 file, then removes the temporary certificate.

## Before publishing source or a binary

~~~bash
python scripts/repository-hygiene.py
backend/.venv/bin/python scripts/security-smoke-test.py
npm --prefix frontend run build
node --check desktop/main.cjs
~~~

Review the generated package for only expected resources. The package build
recreates frontend and backend resources and does not copy backend/.env,
ULTRON account data, an Obsidian vault or a selected 3D model into the app.
