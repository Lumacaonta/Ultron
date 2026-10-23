# macOS release guide

ULTRON's source is public and checks for private files before every release.
A public macOS app is a separate deliverable: it needs a platform-native build,
a signature and Apple notarization before it can be presented as an official
download.

See [platform support](PLATFORM_SUPPORT.md) for the rollout order: Apple
Silicon first, then Intel Mac, Windows and Linux.

## Build an Apple Silicon final candidate

Run this from a clean checkout on an Apple Silicon Mac:

~~~bash
./scripts/bootstrap.sh
./scripts/release-macos-arm64.sh
~~~

The script rebuilds the frontend and backend from source, creates an arm64
Electron package, verifies both distribution formats and writes:

~~~text
desktop/release/ULTRON-ai-<version>-macos-arm64.dmg
desktop/release/ULTRON-ai-<version>-macos-arm64.dmg.sha256
desktop/release/ULTRON-ai-<version>-macos-arm64.zip
desktop/release/ULTRON-ai-<version>-macos-arm64.zip.sha256
desktop/release/ULTRON-ai-<version>-macos-arm64-SHA256SUMS.txt
~~~

The **DMG is the recommended installer**. It opens a standard macOS window
containing ULTRON ai.app and an Applications shortcut; drag the app to
Applications, then open it normally. The ZIP remains available for portable
installation or independent archive checks.

A person who downloads the DMG does not need Node.js, Python, Git or a
`backend/.env` file. The packaged app includes its interface and local core.
After the person creates a local account, the in-app Quick Tour introduces
Ollama, Obsidian, Mail, Devices, Model Deck, explicit memory saving and Global
Position controls. Repository prerequisites and `backend/.env` are for source
developers only.

An ad-hoc signature is enough for the structural checks but is **not** an
Apple-trusted public signature. Do not describe either distributable as
notarized or official until the production signing step has completed. Publish
an ad-hoc signed package as a GitHub **pre-release/final candidate** only.

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

The release script staples and validates the app ticket, signs the DMG,
submits and staples the DMG, then runs Gatekeeper assessment on both:

~~~bash
codesign --verify --deep --strict \
  'desktop/out/ULTRON ai-darwin-arm64/ULTRON ai.app'

spctl --assess --type execute --verbose=4 \
  'desktop/out/ULTRON ai-darwin-arm64/ULTRON ai.app'

spctl --assess --type open --verbose=4 \
  'desktop/release/ULTRON-ai-<version>-macos-arm64.dmg'
~~~

Publish only after every check passes. Never store a certificate, Apple password,
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
on an Apple Silicon macOS runner, verifies the finished app and mounted DMG,
publishes the DMG, ZIP and checksums, then removes the temporary certificate.

Use a normal GitHub release only after notarization succeeds. Use the preview
release notes for an ad-hoc signed candidate so its status is clear to people
who download it.

## Before publishing source or a binary

~~~bash
python scripts/repository-hygiene.py
backend/.venv/bin/python scripts/security-smoke-test.py
backend/.venv/bin/python scripts/location-lookup-test.py
npm --prefix frontend run build
node --check desktop/main.cjs
~~~

Review the generated package for only expected resources. The package build
recreates frontend and backend resources and does not copy backend/.env,
ULTRON account data, an Obsidian vault or a selected 3D model into the app.

The release notes should also say that Global Position sends a typed place
query only after **Find on Globe** is selected; results are rate-limited and
cached in memory only for the running local core. Voice input uses the
Electron/browser `SpeechRecognition` service available on macOS, which may use
an operating-system or browser speech provider. Fish Audio is optional
text-to-speech and is used only when its credentials are configured.
