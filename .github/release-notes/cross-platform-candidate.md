# ULTRON — cross-platform release candidate

This GitHub pre-release contains only the platform-specific assets that were
built and verified on their native GitHub-hosted runner. Choose the file that
matches your computer:

| Computer | Recommended download |
| --- | --- |
| Mac with M1, M2, M3, M4 or later | ULTRON-ai-<version>-macos-arm64.dmg |
| Mac with an Intel processor | ULTRON-ai-<version>-macos-x64.dmg |
| 64-bit Windows 10 or Windows 11 PC | ULTRON-ai-<version>-windows-x64-Setup.exe |

Every platform also has a portable archive and a SHA-256 checksum manifest.
Do not use an asset for a different architecture.

## Install

- **macOS:** open the DMG and drag **ULTRON ai.app** into **Applications**.
- **Windows:** run the Setup executable. The ZIP is for portable use; extract
  it to a folder you control and start ULTRON ai.exe.

ULTRON includes its desktop interface and local core. It does not require
Node.js, Python, Git or a developer .env file. Create a local account when
the app starts and use the first-launch guide to enable only the integrations
you want.

## Candidate status

These are release candidates. A macOS candidate can be ad-hoc signed until a
Developer ID certificate and Apple notarization complete. A Windows candidate
can be unsigned until an Authenticode certificate is configured. macOS
Gatekeeper or Windows SmartScreen may show a first-run warning for an unsigned
candidate.

Each asset was built from the tagged source, checks its own local backend and
is accompanied by SHA-256 files. Read the
[release guide](https://github.com/Lumacaonta/Ultron/blob/main/docs/RELEASE.md)
for verification, privacy and platform-specific feature status.
