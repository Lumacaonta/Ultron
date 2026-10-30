# Platform support

Ultron AI packages the React interface and local FastAPI core together. Every
download must be built on a native runner for its operating system and CPU.
This prevents a release from combining an Electron shell for one architecture
with a Python core compiled for another.

| Platform | Package | Current release policy |
| --- | --- | --- |
| **macOS Apple Silicon** — M1, M2, M3, M4 and later | DMG, ZIP and SHA-256 manifest | Candidate packages can be published after native verification. A normal public release requires Developer ID signing and Apple notarization. |
| **macOS Intel** — x86_64 | DMG, ZIP and SHA-256 manifest | Candidate packages are built separately on an Intel Mac runner. The same Developer ID and notarization requirement applies. |
| **Windows x64** — 64-bit Windows 10 or Windows 11 | Setup EXE, ZIP and SHA-256 manifest | Candidate packages are built separately on Windows. A normal public release requires an Authenticode signature. |
| **Linux** | None yet | Not published. It needs native desktop integrations, package formats and a separate validation pass. |

The GitHub Releases page is the source of truth for published assets. An
architecture is supported only when the matching asset is attached to that
release and its native release workflow has completed successfully.

## Install the matching package

### Mac with Apple Silicon

Download the file ending in **-macos-arm64.dmg**, open it and drag **Ultron
AI.app** into **Applications**. Do not download the Intel file for an M-series
Mac.

### Mac with an Intel processor

Download the file ending in **-macos-x64.dmg**, open it and drag **Ultron
AI.app** into **Applications**. Do not download the Apple Silicon file for an
Intel Mac.

### Windows x64

Download the file ending in **-windows-x64-Setup.exe**. Run the installer and
start **Ultron AI** from the Start menu. The ZIP is portable: extract it into a
folder you control, then start the included application. It does not update
itself.

All installers include the interface and local core. They do not need Node.js,
Python, Git or a developer .env file. At first launch, create a local account
and use the Quick Tour to enable only the integrations you want.

## What works on every published desktop package

- local accounts, password hashing and isolated local profiles;
- local chat through an optional Ollama installation;
- explicit memory proposals, Obsidian vault browsing and Model Deck catalogues;
- a local loopback core protected by a per-launch desktop capability;
- explicit printer profiles for a selected USB port or a selected private LAN
  OctoPrint or Klipper/Moonraker endpoint;
- checksum files for every published installer and portable archive.

## Platform-specific integration status

| Integration | macOS | Windows x64 |
| --- | --- | --- |
| UltiMaker Cura, Bambu Studio, OrcaSlicer, PrusaSlicer and linked local apps | Native handoff after an explicit action | Native handoff after an explicit action |
| File selection and reveal | Native Finder action | Native Windows file picker and Explorer action |
| Read-only USB, OctoPrint and Moonraker printer telemetry | Available after explicit configuration | Available after explicit configuration |
| Inbox reading and reviewed sending through the platform mail client | Available through macOS Mail | Not included yet |
| Gmail setup through the operating system account settings | Available through macOS Internet Accounts | Not included yet |

Windows does not claim macOS Mail or macOS Internet Accounts support. A future
Windows mail integration needs its own reviewed provider or OAuth design; it
must not store a Google password in Ultron AI.

## Candidate versus normal release

A **candidate** is a native build that passed the source, security and package
checks, but is not necessarily signed by the operating-system publisher:

- macOS candidates can trigger a Gatekeeper first-run warning until Apple
  notarization completes;
- Windows candidates can trigger Microsoft Defender SmartScreen until an
  Authenticode signature is configured.

The release notes and GitHub pre-release flag must say this plainly. Checksums
confirm the downloaded bytes; they do not make an unsigned package trusted by
Apple or Microsoft.

See the [release guide](RELEASE.md) for the exact build, signing and publishing
steps.
