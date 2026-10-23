# ULTRON — macOS Apple Silicon candidate

This candidate is for Macs with Apple Silicon: M1, M2, M3, M4 and later.

## Install

1. Download the **DMG** file.
2. Open it and drag **ULTRON ai.app** to **Applications**.
3. Launch ULTRON from Applications and complete the first-launch guide.

The ZIP and SHA256SUMS.txt files are also included for portable installation
and download verification.

## What is included

- Electron desktop app and local FastAPI core;
- local account profiles, explicit memory confirmation and security boundaries;
- optional Ollama, Obsidian, Mail, Cura and 3D-printer integrations;
- a first-launch guide that keeps optional services off until you choose them.

## Candidate status

The package is built and verified on Apple Silicon macOS from the release
source commit. It is an **ad-hoc signed candidate** while the maintainer
configures a Developer ID certificate and Apple notarization.

macOS can request an explicit first-launch approval. A notarized build will be
published as the normal public release once Apple signing credentials are
available.
