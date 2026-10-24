<p align="center">
  <img src="frontend/public/ultron-mark.png" width="132" alt="ULTRON mark" />
</p>

<h1 align="center">ULTRON</h1>

<p align="center">
  <strong>A private, local-first AI command center for macOS.</strong><br />
  Run your assistant, memory, devices, Obsidian vault, email and 3D workflow from one desktop interface.
</p>

<p align="center">
  <img alt="Platform macOS" src="https://img.shields.io/badge/platform-macOS-0b0b0d?style=for-the-badge&logo=apple&logoColor=white" />
  <img alt="Runtime Electron" src="https://img.shields.io/badge/desktop-Electron-1a1a1f?style=for-the-badge&logo=electron&logoColor=61dafb" />
  <img alt="AI local" src="https://img.shields.io/badge/AI-local--first-ff3b3b?style=for-the-badge" />
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-ff3b3b?style=for-the-badge" />
</p>

<p align="center">
  <a href="#download-and-first-launch">Download</a> ·
  <a href="#build-and-run-from-source-developers">Build from source</a> ·
  <a href="#what-is-inside">Features</a> ·
  <a href="#privacy-and-security">Privacy</a> ·
  <a href="#build-a-macos-app">Build</a> ·
  <a href="docs/RELEASE.md">Release guide</a>
</p>

## See ULTRON in action

<p align="center">
  <img src="docs/images/ultron-neural-core.jpg" alt="ULTRON Neural Core command center" width="100%" />
</p>

<p align="center"><em>The Neural Core: a local command center for the agent, memory, devices and system telemetry.</em></p>

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/ultron-devices-command.jpg" alt="ULTRON Device Command and Printer Connection Center" />
      <strong>Device Command</strong><br />
      Monitor the Mac, choose an explicit printer connection and open the 3D workflow from one local panel.
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/ultron-model-deck.jpg" alt="ULTRON Model Deck with software bridge" />
      <strong>Model Deck</strong><br />
      Inspect local fabrication assets and hand the selected file to a local slicer, CAD tool or printer studio.
    </td>
  </tr>
</table>

_All screenshots use an isolated demo operator. They contain no vault, email, selected model or personal account data._

---

> [!IMPORTANT]
> ULTRON launches first on **macOS Apple Silicon**. It is designed for people who want a local assistant and local control surface, without an ULTRON cloud account or telemetry service.

---

## Download and first launch

The current public build targets **Macs with M1, M2, M3, M4 and later**.
It is published as an Apple Silicon **final candidate / pre-release** so people
can test the complete app before the notarized macOS release.

[**Download ULTRON for Apple Silicon →**](https://github.com/Lumacaonta/Ultron/releases)

Choose the newest **DMG** installer:

1. Open the DMG and drag **ULTRON ai.app** to **Applications**.
2. Open ULTRON from Applications and create a local account.
3. The short first-run tour opens after sign-in. It introduces local AI,
   Obsidian, email, devices, the Model Deck, memory and privacy controls.
4. Complete only the integrations you want. You can reopen the tour at any
   time from **Settings → Advanced → Open Quick Tour**.

The downloaded app already includes its interface and local core. **You do not
need Node.js, Python, Git or a `.env` file to use the DMG.** The ZIP remains
available for portable installation, and each release includes SHA-256
checksums.

Apple notarization requires the maintainer's Developer ID certificate. Until a
notarized build is published, macOS can ask for explicit first-run approval.
The candidate is not presented as an Apple-notarized official release.

| Platform | Status |
| --- | --- |
| **macOS Apple Silicon** | Final-candidate DMG and ZIP available; notarized official release next. |
| **macOS Intel** | Planned after Apple Silicon. |
| **Windows** | Planned after Intel Mac. |
| **Linux** | Planned after Windows. |

Read [platform support](docs/PLATFORM_SUPPORT.md) for the exact release status.

---

## What is inside

| Surface | What it does |
| --- | --- |
| **Agent Console** | Talk to a local Ollama model, keep the recent conversation context, use voice input, prepare memory entries and send reviewed actions. |
| **Neural Core** | Explore a live 3D relationship graph for local knowledge, devices, vault content and saved memory. |
| **Memory Vault** | Store only confirmed memories; browse an Obsidian vault without importing it automatically. |
| **Model Deck** | Catalog any selected local fabrication file. Inspect STL, OBJ, 3MF, AMF, PLY, GLB, glTF and G-code in-app; hand CAD, slicer and other native formats to Cura, Bambu Studio, OrcaSlicer, PrusaSlicer or a local macOS app you choose. Start a linked app from the deck to use its own printer setup. |
| **Device Control** | See local system activity and configure one explicit printer profile: Marlin-compatible USB, OctoPrint on local Wi-Fi/Ethernet, or Klipper/Moonraker on local Wi-Fi/Ethernet. |
| **Accounts and Mail** | Create local email/password accounts with isolated ULTRON profiles; optionally configure SMTP codes and macOS Mail actions. |

### Local by default

- **Ollama** powers chat and memory extraction on your machine.
- **Obsidian** remains your vault. ULTRON reads it on demand and writes only after an explicit action.
- **Cura, Bambu Studio, OrcaSlicer, PrusaSlicer, Finder, Mail and serial devices** are called through the current macOS user account only after an explicit action.
- **Printer telemetry** is read-only. ULTRON does not upload jobs, move axes, set temperatures or discover devices across your network.
- **No ULTRON cloud account, cloud sync or telemetry pipeline** is included.

---

## Architecture

```mermaid
flowchart LR
    A[ULTRON desktop shell] --> B[React interface]
    A --> C[FastAPI local core]
    C --> D[Ollama<br/>127.0.0.1]
    C --> E[Account profiles<br/>local private-profile storage]
    C --> F[Obsidian vault]
    C --> G[Mail · Model apps · Finder · Devices]

    classDef red fill:#240609,stroke:#ff3b3b,color:#ffffff,stroke-width:2px;
    classDef dark fill:#0b0b0d,stroke:#5c1a20,color:#ffffff;
    class A,B,C red;
    class D,E,F,G dark;
```

The packaged application serves its interface from `ultron://app`, starts the local API on a **new loopback port for every launch**, and requires a per-launch desktop capability. It does not expose the core to the LAN by default.

---

## Build and run from source (developers)

This section is for people who want to modify ULTRON or run it from a cloned
repository. It is separate from installing the downloadable app above.

### 1. Install the prerequisites

| Required | Optional integrations |
| --- | --- |
| macOS · Node.js 22.13+ · Python 3.11+ · Git | [Obsidian](https://obsidian.md/download), [UltiMaker Cura](https://ultimaker.com/software/ultimaker-cura/), Bambu Studio, OrcaSlicer, PrusaSlicer, macOS Mail, SMTP, [Fish Audio](https://fish.audio/) |
| [Ollama](https://ollama.com/download) | A local Obsidian vault and a supported 3D printer |

### 2. Clone and bootstrap

```bash
git clone https://github.com/Lumacaonta/Ultron.git
cd Ultron
./scripts/bootstrap.sh
```

The bootstrap script creates a safe local `backend/.env`, a Python environment and reproducible Node dependency installs from the lockfiles.

### 3. Install a local model

ULTRON uses `llama3.2` by default. Browse available sizes on the [official Ollama Llama 3.2 page](https://ollama.com/library/llama3.2).

```bash
ollama pull llama3.2
```

### 4. Start ULTRON for development

```bash
# Terminal 1 — local core
backend/.venv/bin/python backend/launcher.py

# Terminal 2 — interface
npm --prefix frontend run dev
```

Open the local Vite address printed in the second terminal.

---

## Set up an installed copy

After you create a local account, ULTRON shows a six-step Quick Tour. It is
designed to get a new installation running without a technical setup screen:

1. Connect Ollama only if you want local AI replies.
2. Choose an Obsidian vault only if you want ULTRON to browse local notes.
3. Add Gmail through macOS Internet Accounts only if you want the Mail tools.
4. Open Devices and choose a printer profile when you want read-only status through USB, OctoPrint or Moonraker. Use Model Deck to choose a file, open a linked local app for its own printer setup, or pass the file to Cura, Bambu Studio, OrcaSlicer, PrusaSlicer or another local app.
5. Press **VAULT** in chat only when you want that command written to the
   ULTRON note; ordinary chat is not silently archived.
6. Set a Global Position only when you choose to search for a place or use the
   device-location control.

You can skip any step and finish it later in Settings. The guide is available
again from **Settings → Advanced → Open Quick Tour**.

<details>
<summary><strong>Account email and password recovery</strong></summary>

ULTRON accounts live on the local installation. SMTP is optional: leave its fields empty for an offline local account.

If you configure SMTP, ULTRON delivers a short, one-time verification or recovery code. Email credentials require SSL or STARTTLS by default. The code expires and can be used once.

The assistant's Mail integration is separate: it operates through the account already configured in macOS Mail and sends a message only from an explicit reviewed action.

</details>

<details>
<summary><strong>Advanced configuration for source builds</strong></summary>

This section applies only when you cloned the repository and run ULTRON from
source. It does **not** apply to the downloaded DMG: configure supported
integrations there through the app's Settings screens instead.

For a source build, copy [`backend/.env.example`](backend/.env.example) to
`backend/.env` and change only what you need.

| Setting | Use |
| --- | --- |
| `ULTRON_OLLAMA_URL`, `ULTRON_OLLAMA_MODEL` | Select the local Ollama endpoint and model. |
| `ULTRON_MEMORY_MODEL` | Select the model used for memory extraction. |
| `ULTRON_AUTH_REQUIRE_EMAIL_VERIFICATION` | Require email confirmation when SMTP is configured. |
| `ULTRON_SMTP_*` | Enable encrypted verification and recovery email. |
| `ULTRON_GEOCODER_URL` | Optional Nominatim-compatible HTTPS provider for the explicit Global Position search. |
| `FISH_API_KEY`, `FISH_VOICE_ID` | Enable optional Fish Audio text-to-speech for a source build. |

Never commit `backend/.env`, a vault, a database or an API key.

</details>

---

## Privacy and security

| Protection | Implementation |
| --- | --- |
| **Account separation** | Each ULTRON account has its own local profile, configuration, skills and memory database. |
| **Password protection** | Passwords use scrypt hashes; session tokens are stored only as hashes in the local database. |
| **Desktop channel** | The local backend uses a random port and a per-launch capability generated by Electron. |
| **Browser isolation** | Electron uses context isolation, sandboxing, disabled Node integration, strict navigation controls and an app-owned origin. |
| **Explicit memory** | Normal chat does not silently save a memory. The person confirms a proposal before it is committed. |
| **Release hygiene** | Automated checks reject likely credentials, private paths, databases, backups and generated artifacts from tracked source. |
| **Fabrication boundary** | Printer profiles are account-scoped; saved network targets must resolve to local addresses; secrets use macOS Keychain when available and never appear in API responses or JSON profile files. |

> [!NOTE]
> ULTRON profiles are separate accounts within one macOS user account. They do not protect files from somebody who can already use that same macOS account. Use separate macOS accounts for separate people.

### External requests

ULTRON stays local unless you enable a feature that needs an external service:

- downloading or updating a model through Ollama;
- optional SMTP verification or recovery mail;
- voice input uses the Electron/browser `SpeechRecognition` service available
  on the Mac. Depending on macOS and its speech-service configuration, that
  service can use an operating-system or browser speech provider; review the
  microphone and speech privacy settings on the Mac before using it;
- optional Fish Audio text-to-speech, only when you configure Fish credentials.
  Fish Audio is not used for microphone input;
- web research;
- typed place search through OpenStreetMap Nominatim, only after you choose
  **Find on Globe**. The query is rate-limited and any result cache exists only
  in memory while the local core is running;
- weather refreshes through Open-Meteo.

Printer profiles are not an external cloud request: ULTRON accepts only the
single local USB port or private LAN address you explicitly select. Bambu Lab
file handoff is available through Bambu Studio; Bambu printer pairing and
printer control remain inside Bambu Studio.

Read [SECURITY.md](SECURITY.md) for responsible disclosure guidance.

---

## Build a macOS app

Create a clean package from the repository root:

```bash
./scripts/build-macos.sh
./scripts/verify-release.sh
```

For a distributable Apple Silicon ZIP and SHA-256 checksum, run:

~~~bash
./scripts/release-macos-arm64.sh
~~~

The output app is created under:

```text
desktop/out/ULTRON ai-darwin-arm64/ULTRON ai.app
```

The release script rebuilds the interface, packages the Python core, checks the app archive and verifies its local code signature.

> [!CAUTION]
> A public macOS binary needs a **Developer ID Application** certificate and Apple notarization. The downloadable Apple Silicon build is clearly marked as a preview until that check succeeds. Build with `ULTRON_CODESIGN_IDENTITY`, then follow the [macOS release guide](docs/RELEASE.md) before publishing an official binary.

---

## Verify a checkout

```bash
backend/.venv/bin/python scripts/security-smoke-test.py
backend/.venv/bin/python scripts/location-lookup-test.py
backend/.venv/bin/python scripts/fabrication-integration-test.py
python scripts/repository-hygiene.py
npm --prefix frontend run build
node --check desktop/main.cjs
```

The checks use temporary data and no real account, model, printer, slicer or LAN target. They cover account login, logout, account isolation, memory confirmation, SMTP code delivery, API headers, CORS, the per-launch desktop channel, Global Position lookup, model selection boundaries, native-app handoff boundaries, local printer URL validation and private credential storage.

---

## Project map

```text
ULTRON/
├── backend/       FastAPI core, local accounts, memory and integrations
├── frontend/      React interface and the Neural Core visual system
├── desktop/       Electron shell, security boundary and macOS packaging
├── scripts/       Bootstrap, build, release and hygiene checks
├── docs/          Public release documentation
└── .github/       Continuous verification workflow
```

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), keep personal data out of commits, and run the verification commands before opening a pull request.

## License

Released under the [MIT License](LICENSE).
