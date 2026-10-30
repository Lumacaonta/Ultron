# Contributing to Ultron AI

Thanks for helping improve Ultron AI.

## Scope

Ultron AI is a local-first desktop application. Contributions should preserve these expectations:

- The local backend stays bound to loopback unless a user deliberately changes that deployment choice.
- User data, vaults, models, mail, and device access remain local by default.
- Any external connection is disclosed in the interface and triggered only by the person using the app.
- Account data stays isolated per local account.

## Set up a development copy

Follow the [development setup](README.md#build-and-run-from-source-developers) section in the README. Use a fresh test account, a test Obsidian vault, and non-sensitive sample models while developing.

## Make a change

1. Create a branch with a concise name, such as `fix/model-deck-preview`.
2. Keep commits focused.
3. Run the relevant build before opening a pull request:

   ```bash
   npm --prefix frontend run build
   backend/.venv/bin/python -m py_compile backend/main.py
   ```

4. Update the README or `.env.example` when configuration, privacy behavior, or setup changes.
5. Describe user-visible behavior and how you checked it in the pull request.

## Privacy and security checklist

Before committing, make sure the diff contains none of the following:

- API keys, SMTP passwords, cookies, password-reset URLs, or session secrets.
- Real email addresses, names, vault notes, chat history, device serial numbers, or precise locations.
- Personal filesystem paths such as `/Users/...` or `C:\\Users\\...`.
- `.env` files, SQLite databases, package output, Python environments, `node_modules`, or generated app bundles.

Use placeholders such as `person@example.com`, `/path/to/vault`, and `YOUR_SECRET_HERE` in documentation and test fixtures.

## UI changes

Include a screenshot or short recording for visible UI work. Redact every personal detail before uploading it. Preserve keyboard access, visible focus states, readable contrast, and reduced-motion behavior when adding effects.

## Issues and pull requests

Use GitHub Issues for reproducible bugs and feature proposals. Do not report security vulnerabilities in a public issue; follow [SECURITY.md](SECURITY.md) instead.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
