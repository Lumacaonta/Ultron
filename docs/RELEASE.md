# Release guide

Ultron AI is a local-first desktop application. A public binary is a separate
deliverable from public source code: it must be built on the matching operating
system and processor, pass source and package checks, and carry the correct
signing status in the release notes.

This guide covers three native outputs:

| Target | Native build command | Published installer |
| --- | --- | --- |
| macOS Apple Silicon | ./scripts/release-macos-arm64.sh | Ultron-AI-<version>-macos-arm64.dmg |
| macOS Intel | ./scripts/release-macos-x64.sh | Ultron-AI-<version>-macos-x64.dmg |
| Windows x64 | pwsh -NoProfile -ExecutionPolicy Bypass -File ./scripts/release-windows-x64.ps1 | Ultron-AI-<version>-windows-x64-Setup.exe |

Read [platform support](PLATFORM_SUPPORT.md) before publishing. A platform is
supported only when its matching artifact is attached to the GitHub release.

## Release safety rules

1. Build each architecture on a **native runner**. PyInstaller embeds native
   Python components, so an Apple Silicon core cannot be reused for Intel Mac
   or Windows.
2. Publish an unsigned or ad-hoc-signed build only as a GitHub **pre-release**
   / candidate. Do not call it notarized, signed or official.
3. Do not put an Apple certificate, Authenticode certificate, private key,
   .env file, account database, Obsidian vault, selected model, log or private
   path into Git.
4. A checksum proves file integrity after download. It does not replace Apple
   notarization or Windows Authenticode signing.
5. Start a newly built app with an empty local data directory and create a
   fresh test account before publishing it.

## Source checks before any platform build

Run these from a clean checkout, using the Python environment created by
scripts/bootstrap.sh on macOS or the native Windows setup used by the Windows
release script:

~~~bash
python scripts/repository-hygiene.py
backend/.venv/bin/python -m py_compile backend/auth.py backend/email_service.py backend/external_apps.py backend/launcher.py backend/main.py backend/memory.py backend/printer_service.py backend/research.py backend/skills_api.py backend/skills_engine.py
backend/.venv/bin/python scripts/security-smoke-test.py
backend/.venv/bin/python scripts/location-lookup-test.py
backend/.venv/bin/python scripts/fabrication-integration-test.py
npm --prefix frontend run lint
npm --prefix frontend run build
node --check desktop/main.cjs
node --check desktop/preload.cjs
node --check desktop/forge.config.cjs
node scripts/verify-desktop-bridge.mjs
node scripts/verify-windows-config.mjs
~~~

The isolated tests use temporary data. They do not access an existing account,
Obsidian vault, printer, mail account or external application.

## macOS Apple Silicon

Run this on an Apple Silicon Mac or an Apple Silicon GitHub runner:

~~~bash
./scripts/bootstrap.sh
./scripts/release-macos-arm64.sh
~~~

The output is written below desktop/release:

~~~text
Ultron-AI-<version>-macos-arm64.dmg
Ultron-AI-<version>-macos-arm64.dmg.sha256
Ultron-AI-<version>-macos-arm64.zip
Ultron-AI-<version>-macos-arm64.zip.sha256
Ultron-AI-<version>-macos-arm64-SHA256SUMS.txt
~~~

The DMG is the recommended installer. It contains Ultron AI.app, an
Applications shortcut and a short installation note. A person using the DMG
does not need Node.js, Python, Git or a developer .env file.

Verify the completed archive from its release directory:

~~~bash
cd desktop/release
shasum -a 256 -c Ultron-AI-<version>-macos-arm64-SHA256SUMS.txt
~~~

## macOS Intel

Run this on a native x86_64 Intel Mac or an Intel macOS GitHub runner. Do not
run it through Rosetta on Apple Silicon:

~~~bash
./scripts/bootstrap.sh
./scripts/release-macos-x64.sh
~~~

It creates the same DMG, ZIP and checksum set with **macos-x64** in each file
name:

~~~text
Ultron-AI-<version>-macos-x64.dmg
Ultron-AI-<version>-macos-x64.dmg.sha256
Ultron-AI-<version>-macos-x64.zip
Ultron-AI-<version>-macos-x64.zip.sha256
Ultron-AI-<version>-macos-x64-SHA256SUMS.txt
~~~

Verify it with:

~~~bash
cd desktop/release
shasum -a 256 -c Ultron-AI-<version>-macos-x64-SHA256SUMS.txt
~~~

## Windows x64

Run the Windows release script from native 64-bit Windows PowerShell. For a
fresh source checkout, prepare it once with the bootstrap script. The release
script rebuilds the interface and bundled local core, creates the installer and
portable archive, then validates the package before returning:

~~~powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File ./scripts/bootstrap-windows.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File ./scripts/release-windows-x64.ps1
~~~

The release directory receives:

~~~text
Ultron-AI-<version>-windows-x64-Setup.exe
Ultron-AI-<version>-windows-x64-Setup.exe.sha256
Ultron-AI-<version>-windows-x64.zip
Ultron-AI-<version>-windows-x64.zip.sha256
Ultron-AI-<version>-windows-x64-SHA256SUMS.txt
~~~

The Setup EXE is the recommended installer. The ZIP is portable and should be
extracted to a folder owned by the person using it. Verify a Windows download
with the manifest or by comparing a file hash:

~~~powershell
Get-FileHash -Algorithm SHA256 ./Ultron-AI-<version>-windows-x64-Setup.exe
~~~

The Windows package includes the local core, accounts, memory, Ollama,
Obsidian, Model Deck and explicit printer connections. macOS Mail and the
macOS Internet Accounts Gmail setup are deliberately unavailable on Windows;
they are not silently replaced by a cloud mail service.

## Signing status

### macOS

The Forge configuration enables Hardened Runtime and the minimal entitlements
in [desktop/entitlements.mac.plist](../desktop/entitlements.mac.plist) when
ULTRON_CODESIGN_IDENTITY is present. An Apple Silicon or Intel normal public
release requires all of the following:

- a Developer ID Application certificate;
- Hardened Runtime and a successful codesign verification;
- Apple notarization and stapling;
- successful Gatekeeper assessment of the final app and DMG;
- a fresh-account launch test on the matching architecture.

Provide Apple credentials only through the local environment or GitHub Actions
secrets. The signed macOS workflows use these repository secrets:

| Secret | Purpose |
| --- | --- |
| ULTRON_MACOS_CERTIFICATE_BASE64 | Base64-encoded Developer ID certificate in P12 form. |
| ULTRON_MACOS_CERTIFICATE_PASSWORD | Password for the P12 certificate. |
| ULTRON_MACOS_KEYCHAIN_PASSWORD | Random password for the temporary CI keychain. |
| ULTRON_CODESIGN_IDENTITY | Full Developer ID Application identity name. |
| ULTRON_APPLE_ID | Apple ID used for notarization. |
| ULTRON_APPLE_APP_SPECIFIC_PASSWORD | App-specific Apple ID password. |
| ULTRON_APPLE_TEAM_ID | Apple Developer Team ID. |

A build without this signing path is an ad-hoc candidate. It can trigger a
Gatekeeper warning and must remain marked as a pre-release.

### Windows

A normal public Windows installer requires an Authenticode certificate and
timestamped signature validation. The Windows workflow reads its certificate
only from repository secrets and removes the temporary certificate after the
build. Do not add a PFX, certificate password or publisher identity to source
control.

| Secret or variable | Purpose |
| --- | --- |
| ULTRON_WINDOWS_CERTIFICATE_BASE64 | Base64-encoded Authenticode PFX certificate. |
| ULTRON_WINDOWS_CERTIFICATE_PASSWORD | Password for the PFX certificate. |
| ULTRON_WINDOWS_TIMESTAMP_SERVER | Optional RFC 3161-compatible timestamp service; the default is used when absent. |

Without an Authenticode signature, Windows Defender SmartScreen can show a
first-run warning. Publish that output only as a candidate and state that
status in the GitHub release notes.

## Publish through GitHub Actions

The repository keeps three manual native release workflows:

| Workflow | Runner | Assets it attaches |
| --- | --- | --- |
| Publish signed macOS ARM64 release | Apple Silicon macOS | macos-arm64 DMG, ZIP and checksums |
| Publish signed macOS Intel release | Intel macOS | macos-x64 DMG, ZIP and checksums |
| Publish Windows x64 release | Windows x64 | Setup EXE, ZIP and checksums |

Run every required workflow with the **same release tag** and the same
pre-release setting. The first workflow creates the release; later workflows
attach their platform assets to that same tag without replacing another
platform's artifacts.

For a candidate, use a pre-release tag and leave any unavailable signing option
disabled. For a normal public release, enable the signing option only after the
matching signing secrets are configured and the native tests succeed. Do not
mix candidate and normal assets under one tag: create a new tag when moving
from a candidate to a normal release.

## Final release checklist

Before publishing or removing the pre-release flag:

- source hygiene and isolated security checks pass;
- each intended platform was built on its native architecture;
- each platform's package verification script passes;
- every installer, ZIP and checksum manifest is attached to the same tag;
- a fresh local account can start the packaged app on every target platform;
- the Quick Tour, account sign-in, local core and Model Deck open without
  renderer errors;
- no release asset contains a private profile, vault, selected model, .env,
  database, personal path or release credential;
- the release notes accurately say whether macOS is notarized and Windows is
  Authenticode-signed.

The package build recreates frontend and backend resources from source. It
does not copy backend .env files, local account data, an Obsidian vault or a
selected fabrication model into the release.
