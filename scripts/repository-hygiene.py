#!/usr/bin/env python3
"""Fail a public release check when tracked source contains private material.

The check intentionally works only with Git-tracked files. It can run in CI
without reading an operator's local ``.env``, build output, vault, or account
directory. It catches the files and high-confidence credential formats that
must never be part of a public source release.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEXT_EXTENSIONS = {
    ".cjs",
    ".css",
    ".env",
    ".example",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".py",
    ".sh",
    ".toml",
    ".txt",
    ".yml",
    ".yaml",
}
DISALLOWED_PATH_PARTS = (
    "/node_modules/",
    "/out/",
    "/build/",
    "/dist/",
    "/.venv/",
    ".before-",
    ".backup",
    ".corrupted-",
)
DISALLOWED_PATH_PREFIXES = (
    ".ultron",
    "backend/.ultron",
    "backend/profiles/",
    "backend/__pycache__/",
    "desktop/release/",
)
DISALLOWED_SUFFIXES = (
    ".db",
    ".sqlite",
    ".sqlite3",
    ".pem",
    ".p12",
    ".pfx",
    ".mobileprovision",
    ".cer",
    ".crt",
    ".pyc",
    ".log",
    ".jsonl",
    ".dmg",
    ".zip",
    ".ds_store",
)
SECRET_PATTERNS = (
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"),
    re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{20,}\b"),
    re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"(?im)^[ \t]*(?:OPENAI_API_KEY|FISH_API_KEY|ULTRON_AUTH_SECRET|ULTRON_SMTP_PASSWORD|GITHUB_TOKEN)[ \t]*=[ \t]*(?!your-|replace|change|example|<)[^\s#]{16,}"),
)
UNSAFE_POSIX_PATH = re.compile(r"/(?:Users|home)/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}/")
UNSAFE_WINDOWS_PATH = re.compile(r"(?i)[A-Z]:\\\\Users\\\\[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\\\\")


def tracked_files() -> list[Path]:
    try:
        result = subprocess.run(
            ["git", "-C", str(ROOT), "ls-files", "-z"],
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise SystemExit("Run repository-hygiene.py from a Git checkout.") from error

    return [
        ROOT / item.decode("utf-8")
        for item in result.stdout.split(b"\0")
        if item
    ]


def is_disallowed_path(path: Path) -> bool:
    relative = path.relative_to(ROOT).as_posix()
    if relative == "backend/.env.example":
        return False
    lower = relative.casefold()
    if lower.endswith("/.env") or path.name == ".env":
        return True
    if any(lower.startswith(prefix) for prefix in DISALLOWED_PATH_PREFIXES):
        return True
    if lower.endswith(".app") or ".app/" in lower:
        return True
    return (
        any(part in lower for part in DISALLOWED_PATH_PARTS)
        or lower.endswith(DISALLOWED_SUFFIXES)
    )


def should_scan_text(path: Path) -> bool:
    return path.suffix.casefold() in TEXT_EXTENSIONS or path.name.startswith(".")


def main() -> int:
    violations: list[str] = []

    for path in tracked_files():
        relative = path.relative_to(ROOT).as_posix()
        if is_disallowed_path(path):
            violations.append(f"tracked private or generated path: {relative}")
            continue

        if not path.is_file() or not should_scan_text(path):
            continue

        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            violations.append(f"unexpected binary source file: {relative}")
            continue

        if UNSAFE_POSIX_PATH.search(content) or UNSAFE_WINDOWS_PATH.search(content):
            violations.append(f"personal filesystem path: {relative}")

        if any(pattern.search(content) for pattern in SECRET_PATTERNS):
            violations.append(f"likely credential or private key: {relative}")

    if violations:
        print("Repository hygiene check failed:", file=sys.stderr)
        for violation in violations:
            print(f"- {violation}", file=sys.stderr)
        return 1

    print("Repository hygiene check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
