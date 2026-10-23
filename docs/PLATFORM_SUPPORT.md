# Platform support

ULTRON is released in phases so every download is built and tested for the
platform it claims to support.

| Platform | Status | Download |
| --- | --- | --- |
| **macOS Apple Silicon** — M1, M2, M3 and later | First target. A final-candidate pre-release provides a standard drag-to-Applications DMG, a ZIP and checksums. A notarized official build needs the maintainer's Apple Developer credentials. | ULTRON-ai-*-macos-arm64.dmg |
| **macOS Intel** | Planned after Apple Silicon. It needs a separate x64 Electron and PyInstaller build. | Not published |
| **Windows** | Planned after macOS Intel. It needs native file/Cura/Mail integration, a Windows backend and a signed installer. | Not published |
| **Linux** | Planned after Windows. It needs Linux integration adapters, package formats and testing. | Not published |

## Apple Silicon final candidate

The Apple Silicon candidate is built on an Apple Silicon GitHub-hosted macOS
runner. It runs source, security and package checks, then includes a DMG
installer, a ZIP and SHA-256 checksums. The DMG is the recommended download:
open it and drag ULTRON ai.app to Applications.

The download already contains the desktop interface and local core. A person
installing the DMG does not need Node.js, Python, Git or a developer `.env`
file. After a local account is created, ULTRON shows its Quick Tour for the
optional AI, Obsidian, Mail, device and privacy controls.

Until it is signed with a Developer ID certificate and notarized by Apple,
macOS may show a Gatekeeper warning. The preview is for testers who explicitly
want to try ULTRON before the notarized release is available. It is a
pre-release candidate, not an Apple-notarized official download.

## Official macOS release

An official macOS direct download requires all of the following:

1. a **Developer ID Application** certificate;
2. Hardened Runtime and the minimal entitlements in
   [desktop/entitlements.mac.plist](../desktop/entitlements.mac.plist);
3. Apple notarization and stapling;
4. a successful spctl --assess result on the final ZIP's app;
5. a fresh-account launch test on Apple Silicon.

See [the release guide](RELEASE.md) for the build and GitHub Actions setup.
