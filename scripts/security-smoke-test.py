#!/usr/bin/env python3
"""Run the local, dependency-free security checks for an ULTRON checkout.

This script deliberately uses a temporary app-data directory, temporary
accounts, and a fake SMTP transport. It never reads a developer's vault,
Mail account, existing ULTRON data, or `.env` credentials.
"""

from __future__ import annotations

import json
import os
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _parse_json_or_text(raw: str) -> dict:
    try:
        return json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {"raw": raw}


def _api(
    port: int,
    method: str,
    path: str,
    *,
    payload: dict | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], dict]:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request_headers = {"Accept": "application/json", **(headers or {})}
    if body is not None:
        request_headers.setdefault("Content-Type", "application/json")

    request = Request(
        f"http://127.0.0.1:{port}{path}",
        data=body,
        headers=request_headers,
        method=method,
    )

    try:
        with urlopen(request, timeout=4) as response:
            return (
                response.status,
                {key.lower(): value for key, value in response.headers.items()},
                _parse_json_or_text(response.read().decode("utf-8")),
            )
    except HTTPError as error:
        return (
            error.code,
            {key.lower(): value for key, value in error.headers.items()},
            _parse_json_or_text(error.read().decode("utf-8")),
        )


def _assert_private_mode(path: Path, *, executable: bool = False) -> None:
    if os.name == "nt":
        return
    mode = stat.S_IMODE(path.stat().st_mode)
    forbidden = 0o077 if not executable else 0o022
    assert mode & forbidden == 0, f"{path} has insecure mode {oct(mode)}"


def _check_mail_code_and_tls(temp_root: Path) -> None:
    """Exercise the account-mail path without making an SMTP connection."""

    os.environ.update(
        {
            "ULTRON_AUTH_DATA_DIR": str(temp_root / "mail-auth-data"),
            "ULTRON_AUTH_SECRET": "mail-test-secret-" + ("m" * 64),
            "ULTRON_SMTP_HOST": "smtp.example.test",
            "ULTRON_SMTP_PORT": "587",
            "ULTRON_SMTP_USERNAME": "test-user",
            "ULTRON_SMTP_PASSWORD": "test-password",
            "ULTRON_SMTP_FROM": "ULTRON <noreply@example.test>",
            "ULTRON_SMTP_USE_SSL": "false",
            "ULTRON_SMTP_STARTTLS": "true",
            "ULTRON_SMTP_REQUIRE_TLS": "true",
        }
    )
    sys.path.insert(0, str(BACKEND))
    import auth  # noqa: PLC0415

    class FakeSMTP:
        messages: list[object] = []
        started_tls = False

        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def ehlo(self) -> None:
            return None

        def starttls(self, **_kwargs) -> None:
            type(self).started_tls = True

        def login(self, _username: str, _password: str) -> None:
            return None

        def send_message(self, message: object) -> None:
            type(self).messages.append(message)

        def __enter__(self):
            return self

        def __exit__(self, *_args) -> bool:
            return False

    code = "safe-one-time-code-123456"
    with patch.object(auth.smtplib, "SMTP", FakeSMTP):
        auth._send_auth_email(
            recipient="operator@example.test",
            purpose="verify",
            token=code,
        )

    assert FakeSMTP.started_tls
    assert len(FakeSMTP.messages) == 1
    content = FakeSMTP.messages[0].get_content()
    assert code in content
    assert "http://" not in content and "https://" not in content

    os.environ["ULTRON_SMTP_STARTTLS"] = "false"
    os.environ["ULTRON_SMTP_USE_SSL"] = "false"
    try:
        auth._send_auth_email(
            recipient="operator@example.test",
            purpose="reset",
            token=code,
        )
    except RuntimeError as error:
        assert "SSL or STARTTLS" in str(error)
    else:
        raise AssertionError("unencrypted account SMTP was accepted")


def _check_backend(temp_root: Path) -> None:
    port = _free_port()
    launch_secret = "capability-" + ("a" * 64)
    instance_id = "security-smoke-instance"
    app_data = temp_root / "api-auth-data"
    environment = {
        **os.environ,
        "ULTRON_AUTH_DATA_DIR": str(app_data),
        "ULTRON_AUTH_SECRET": "api-test-secret-" + ("b" * 64),
        "ULTRON_AUTH_REQUIRE_EMAIL_VERIFICATION": "false",
        "ULTRON_PORT": str(port),
        "ULTRON_LAUNCH_SECRET": launch_secret,
        "ULTRON_LAUNCH_INSTANCE_ID": instance_id,
        "ULTRON_ENABLE_API_DOCS": "false",
    }
    process = subprocess.Popen(
        [sys.executable, "launcher.py"],
        cwd=BACKEND,
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        for _ in range(80):
            try:
                status, _headers, health = _api(
                    port,
                    "GET",
                    "/api/health",
                    headers={"X-Ultron-Launch-Secret": launch_secret},
                )
                if status == 200 and health.get("instance_id") == instance_id:
                    break
            except (URLError, ConnectionError):
                pass
            time.sleep(0.1)
        else:
            raise AssertionError("ULTRON backend did not become ready")

        status, _headers, _payload = _api(port, "GET", "/api/health")
        assert status == 403

        status, _headers, health = _api(
            port,
            "GET",
            "/api/health",
            headers={"X-Ultron-Launch-Secret": launch_secret},
        )
        assert status == 200
        assert health == {"status": "online", "instance_id": instance_id}
        assert _headers.get("cache-control") == "no-store"
        assert _headers.get("x-content-type-options") == "nosniff"
        assert _headers.get("referrer-policy") == "no-referrer"

        status, cors_headers, _payload = _api(
            port,
            "OPTIONS",
            "/api/auth/config",
            headers={
                "Origin": "ultron://app",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-ultron-launch-secret",
            },
        )
        assert status == 200
        assert cors_headers.get("access-control-allow-origin") == "ultron://app"
        assert "x-ultron-launch-secret" in cors_headers.get(
            "access-control-allow-headers", ""
        ).lower()

        status, evil_headers, _payload = _api(
            port,
            "OPTIONS",
            "/api/auth/config",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-ultron-launch-secret",
            },
        )
        assert status == 400
        assert "access-control-allow-origin" not in evil_headers

        status, _headers, _payload = _api(
            port,
            "GET",
            "/docs",
            headers={"X-Ultron-Launch-Secret": launch_secret},
        )
        assert status == 404

        channel = {"X-Ultron-Launch-Secret": launch_secret}
        status, _headers, first = _api(
            port,
            "POST",
            "/api/auth/register",
            payload={
                "email": "account-a@example.test",
                "password": "Long public-test passphrase A 2026!",
                "display_name": "Account A",
            },
            headers=channel,
        )
        assert status == 201 and first.get("token")
        token_a = first["token"]
        account_a_headers = {**channel, "Authorization": f"Bearer {token_a}"}

        _assert_private_mode(app_data)
        _assert_private_mode(app_data / "accounts.db")
        assert token_a.encode("utf-8") not in (app_data / "accounts.db").read_bytes()

        status, _headers, _payload = _api(port, "GET", "/api/system", headers=channel)
        assert status == 401
        status, _headers, _payload = _api(
            port,
            "GET",
            "/api/system",
            headers={"Authorization": f"Bearer {token_a}"},
        )
        assert status == 403
        status, _headers, system = _api(
            port,
            "GET",
            "/api/system",
            headers=account_a_headers,
        )
        assert status == 200 and system.get("hostname") == "LOCAL HOST"

        vault_a = temp_root / "vault-a"
        vault_a.mkdir()
        status, _headers, configured = _api(
            port,
            "POST",
            "/api/obsidian/config",
            payload={"path": str(vault_a)},
            headers=account_a_headers,
        )
        assert status == 200 and configured.get("ok")

        status, _headers, agent = _api(
            port,
            "POST",
            "/api/agent",
            payload={
                "message": "Ricorda che il progetto di test usa archivi separati per account."
            },
            headers=account_a_headers,
        )
        proposal = agent.get("memory_proposal") or {}
        assert status == 200 and proposal.get("id")

        status, _headers, created_skill = _api(
            port,
            "POST",
            "/api/skills",
            payload={
                "name": "Private test skill",
                "description": "Proves account isolation.",
                "trigger": "private test command",
                "action": "ask_ai",
                "target": "",
                "enabled": True,
            },
            headers=account_a_headers,
        )
        assert status == 200 and created_skill.get("skill", {}).get("id")

        status, _headers, second = _api(
            port,
            "POST",
            "/api/auth/register",
            payload={
                "email": "account-b@example.test",
                "password": "Long public-test passphrase B 2026!",
                "display_name": "Account B",
            },
            headers=channel,
        )
        assert status == 201 and second.get("token")
        account_b_headers = {**channel, "Authorization": f"Bearer {second['token']}"}

        status, _headers, b_memory = _api(
            port,
            "GET",
            "/api/memory/count",
            headers=account_b_headers,
        )
        assert status == 200 and b_memory.get("count") == 0
        status, _headers, b_obsidian = _api(
            port,
            "GET",
            "/api/obsidian/status",
            headers=account_b_headers,
        )
        assert status == 200 and not b_obsidian.get("connected") and b_obsidian.get("path") == ""
        status, _headers, b_skills = _api(
            port,
            "GET",
            "/api/skills",
            headers=account_b_headers,
        )
        assert status == 200
        assert not any(item.get("name") == "Private test skill" for item in b_skills.get("skills", []))

        status, _headers, _payload = _api(
            port,
            "POST",
            "/api/memory/commit",
            payload={"proposal_id": proposal["id"]},
            headers=account_b_headers,
        )
        assert status == 404
        status, _headers, committed = _api(
            port,
            "POST",
            "/api/memory/commit",
            payload={"proposal_id": proposal["id"]},
            headers=account_a_headers,
        )
        assert status == 200 and committed.get("saved", 0) > 0
        status, _headers, a_memory = _api(
            port,
            "GET",
            "/api/memory/count",
            headers=account_a_headers,
        )
        assert status == 200 and a_memory.get("count", 0) > 0
        status, _headers, b_memory_after = _api(
            port,
            "GET",
            "/api/memory/count",
            headers=account_b_headers,
        )
        assert status == 200 and b_memory_after.get("count") == 0

        status, _headers, logged_out = _api(
            port,
            "POST",
            "/api/auth/logout",
            headers=account_a_headers,
        )
        assert status == 200 and logged_out.get("ok")
        status, _headers, _payload = _api(
            port,
            "GET",
            "/api/memory/count",
            headers=account_a_headers,
        )
        assert status == 401
    finally:
        process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=8)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="ultron-security-smoke-") as temp_dir:
        temporary_root = Path(temp_dir)
        _check_mail_code_and_tls(temporary_root)
        _check_backend(temporary_root)

    print("ULTRON security smoke test passed")


if __name__ == "__main__":
    main()
