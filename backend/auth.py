"""Local account authentication for ULTRON.

The account store deliberately lives apart from the legacy memory database.
It uses only the Python standard library for password hashing, sessions, and
optional SMTP delivery, so a fresh local install has no authentication service
or cloud dependency to configure.

Routes that own user data use :func:`require_auth` or
:func:`require_verified_auth`, then use ``get_user_data_dir(user["id"])`` for
an account-scoped storage location.
"""

from __future__ import annotations

import base64
import contextvars
import hashlib
import hmac
import os
import re
import secrets
import smtplib
import sqlite3
import ssl
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, Field


def _env_bool(name: str, default: bool) -> bool:
    """Read a conservative boolean environment value."""

    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().casefold() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(value, maximum))


def _private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        # chmod is unavailable on some filesystems. The directory is still
        # private on platforms whose home directories enforce permissions.
        pass


def _auth_data_dir() -> Path:
    configured = os.getenv("ULTRON_AUTH_DATA_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()

    common_data_dir = os.getenv("ULTRON_DATA_DIR", "").strip()
    if common_data_dir:
        return Path(common_data_dir).expanduser().resolve()

    return Path.home() / ".ultron"


AUTH_DATA_DIR = _auth_data_dir()
_private_directory(AUTH_DATA_DIR)

_configured_db = os.getenv("ULTRON_AUTH_DB_PATH", "").strip()
AUTH_DB = (
    Path(_configured_db).expanduser().resolve()
    if _configured_db
    else AUTH_DATA_DIR / "accounts.db"
)
_private_directory(AUTH_DB.parent)
USER_DATA_ROOT = AUTH_DATA_DIR / "profiles"
_private_directory(USER_DATA_ROOT)

PASSWORD_MIN_LENGTH = _env_int(
    "ULTRON_AUTH_PASSWORD_MIN_LENGTH",
    12,
    minimum=8,
    maximum=128,
)
SESSION_TTL_DAYS = _env_int(
    "ULTRON_AUTH_SESSION_TTL_DAYS",
    30,
    minimum=1,
    maximum=365,
)
TOKEN_TTL_MINUTES = _env_int(
    "ULTRON_AUTH_EMAIL_TOKEN_TTL_MINUTES",
    60,
    minimum=10,
    maximum=24 * 60,
)
ALLOW_REGISTRATION = _env_bool("ULTRON_AUTH_ALLOW_REGISTRATION", True)

_EMAIL_PATTERN = re.compile(r"^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$")
_USER_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
_PASSWORD_MAX_LENGTH = 1024


def _smtp_configured() -> bool:
    return bool(
        os.getenv("ULTRON_SMTP_HOST", "").strip()
        and os.getenv("ULTRON_SMTP_FROM", "").strip()
    )


# Email confirmation is automatically required if SMTP is configured. This
# keeps the default local/offline install usable while making a public hosted
# installation safe by default once it has an email transport.
REQUIRE_EMAIL_VERIFICATION = _env_bool(
    "ULTRON_AUTH_REQUIRE_EMAIL_VERIFICATION",
    _smtp_configured(),
)


def _load_secret() -> bytes:
    """Load an operator-supplied secret or create a local private secret.

    A public server should set ``ULTRON_AUTH_SECRET`` explicitly. A local
    desktop install can safely bootstrap itself with a random, mode-600 file
    that persists across restarts, avoiding a hard-coded or ephemeral secret.
    """

    configured = os.getenv("ULTRON_AUTH_SECRET", "").strip()
    if configured:
        if len(configured) < 32:
            raise RuntimeError(
                "ULTRON_AUTH_SECRET must contain at least 32 characters."
            )
        return configured.encode("utf-8")

    secret_file_setting = os.getenv("ULTRON_AUTH_SECRET_FILE", "").strip()
    secret_file = (
        Path(secret_file_setting).expanduser().resolve()
        if secret_file_setting
        else AUTH_DATA_DIR / "auth.secret"
    )
    _private_directory(secret_file.parent)

    try:
        existing = secret_file.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        existing = ""
    except OSError as error:
        raise RuntimeError("ULTRON could not read its local auth secret.") from error

    if existing:
        if len(existing) < 32:
            raise RuntimeError("The local ULTRON auth secret is invalid.")
        return existing.encode("utf-8")

    generated = secrets.token_urlsafe(48)
    try:
        descriptor = os.open(
            secret_file,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(generated)
            handle.write("\n")
    except FileExistsError:
        # A second process created the file between our check and create.
        generated = secret_file.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise RuntimeError("ULTRON could not create its local auth secret.") from error

    try:
        secret_file.chmod(0o600)
    except OSError:
        pass

    if len(generated) < 32:
        raise RuntimeError("The local ULTRON auth secret is invalid.")
    return generated.encode("utf-8")


_SECRET = _load_secret()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _timestamp(value: datetime | None = None) -> str:
    return (value or _now()).isoformat()


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _database_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(AUTH_DB, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    try:
        # The parent directory is private too, but the database itself should
        # never rely on a permissive umask for its protection.
        AUTH_DB.chmod(0o600)
    except OSError:
        pass
    return connection


def init_auth_db() -> None:
    """Create the isolated accounts database and its security indexes."""

    connection = _database_connection()
    try:
        connection.executescript(
            """
            PRAGMA journal_mode = WAL;

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                display_name TEXT NOT NULL DEFAULT '',
                password_hash TEXT NOT NULL,
                email_verified INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                disabled_at TEXT
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                revoked_at TEXT,
                user_agent TEXT NOT NULL DEFAULT ''
            );

            CREATE INDEX IF NOT EXISTS sessions_user_id_idx
                ON sessions(user_id);
            CREATE INDEX IF NOT EXISTS sessions_expiry_idx
                ON sessions(expires_at);

            CREATE TABLE IF NOT EXISTS email_tokens (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                purpose TEXT NOT NULL CHECK(purpose IN ('verify', 'reset')),
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                used_at TEXT
            );

            CREATE INDEX IF NOT EXISTS email_tokens_lookup_idx
                ON email_tokens(token_hash, purpose);
            CREATE INDEX IF NOT EXISTS email_tokens_user_idx
                ON email_tokens(user_id, purpose);
            """
        )
        connection.commit()
    finally:
        connection.close()

    try:
        AUTH_DB.chmod(0o600)
    except OSError:
        pass


init_auth_db()


def get_user_data_dir(user_id: str) -> Path:
    """Return a private, per-account storage directory.

    Use this as the migration target for memories, Obsidian configuration,
    skill configuration, and future integrations. It never accepts an
    arbitrary filesystem path.
    """

    normalized = str(user_id or "").strip().casefold()
    if not _USER_ID_PATTERN.fullmatch(normalized):
        raise ValueError("Invalid ULTRON user id.")

    path = USER_DATA_ROOT / normalized
    _private_directory(path)
    return path


def _encode_bytes(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode_bytes(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=2**15,
        r=8,
        p=1,
        dklen=64,
        maxmem=64 * 1024 * 1024,
    )
    return f"scrypt$32768$8$1${_encode_bytes(salt)}${_encode_bytes(digest)}"


def _verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, n_text, r_text, p_text, salt_text, digest_text = encoded.split("$")
        if algorithm != "scrypt":
            return False

        n = int(n_text)
        r = int(r_text)
        p = int(p_text)
        # Do not allow a corrupted local database to force unbounded work.
        if n < 2**14 or n > 2**16 or r < 1 or r > 16 or p < 1 or p > 8:
            return False

        expected = _decode_bytes(digest_text)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=_decode_bytes(salt_text),
            n=n,
            r=r,
            p=p,
            dklen=len(expected),
            maxmem=64 * 1024 * 1024,
        )
        return hmac.compare_digest(actual, expected)
    except (TypeError, ValueError, UnicodeError, MemoryError):
        return False


_DUMMY_PASSWORD_HASH = _hash_password("ULTRON authentication dummy password")


def _token_digest(token: str) -> str:
    return hmac.new(
        _SECRET,
        token.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _new_token() -> str:
    return secrets.token_urlsafe(48)


def _normalize_email(email: str) -> str:
    normalized = str(email or "").strip().casefold()
    if len(normalized) > 320 or not _EMAIL_PATTERN.fullmatch(normalized):
        raise HTTPException(status_code=422, detail="Enter a valid email address.")

    local, _, domain = normalized.partition("@")
    if not local or not domain or len(local) > 64 or domain.startswith("."):
        raise HTTPException(status_code=422, detail="Enter a valid email address.")
    return normalized


def _validate_password(password: str, *, email: str | None = None) -> str:
    value = str(password or "")
    if len(value) > _PASSWORD_MAX_LENGTH:
        raise HTTPException(status_code=422, detail="Password is too long.")
    if len(value) < PASSWORD_MIN_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=f"Password must be at least {PASSWORD_MIN_LENGTH} characters.",
        )
    if email and email.partition("@")[0] and email.partition("@")[0] in value.casefold():
        raise HTTPException(
            status_code=422,
            detail="Password must not contain your email name.",
        )
    return value


def _clean_display_name(value: str) -> str:
    return " ".join(str(value or "").strip().split())[:80]


def _safe_user(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "email": row["email"],
        "display_name": row["display_name"],
        "email_verified": bool(row["email_verified"]),
        "created_at": row["created_at"],
    }


def _session_response(user: sqlite3.Row | dict[str, Any], token: str, expires_at: str) -> dict[str, Any]:
    return {
        "ok": True,
        "token": token,
        "token_type": "bearer",
        "expires_at": expires_at,
        "user": _safe_user(user),
    }


def _create_session(user: sqlite3.Row, user_agent: str = "") -> dict[str, Any]:
    token = _new_token()
    now = _now()
    expires_at = _timestamp(now + timedelta(days=SESSION_TTL_DAYS))
    connection = _database_connection()
    try:
        connection.execute(
            """
            INSERT INTO sessions (
                id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                uuid4().hex,
                user["id"],
                _token_digest(token),
                _timestamp(now),
                expires_at,
                _timestamp(now),
                str(user_agent or "")[:512],
            ),
        )
        connection.execute(
            "DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL AND revoked_at < ?",
            (_timestamp(now), _timestamp(now - timedelta(days=30))),
        )
        connection.commit()
    finally:
        connection.close()
    return _session_response(user, token, expires_at)


def _send_auth_email(*, recipient: str, purpose: str, token: str) -> None:
    host = os.getenv("ULTRON_SMTP_HOST", "").strip()
    sender = os.getenv("ULTRON_SMTP_FROM", "").strip()
    if not host or not sender:
        raise RuntimeError("Email delivery is not configured.")

    port = _env_int("ULTRON_SMTP_PORT", 587, minimum=1, maximum=65535)
    use_ssl = _env_bool("ULTRON_SMTP_USE_SSL", port == 465)
    use_starttls = _env_bool("ULTRON_SMTP_STARTTLS", not use_ssl)
    require_tls = _env_bool("ULTRON_SMTP_REQUIRE_TLS", True)
    username = os.getenv("ULTRON_SMTP_USERNAME", "").strip()
    password = os.getenv("ULTRON_SMTP_PASSWORD", "")
    has_username = bool(username)
    has_password = bool(password)

    if has_username != has_password:
        raise RuntimeError("SMTP username and password must be configured together.")
    if use_ssl and use_starttls:
        raise RuntimeError("Choose either SMTP SSL or STARTTLS, not both.")
    if (require_tls or has_username) and not (use_ssl or use_starttls):
        raise RuntimeError("ULTRON requires SSL or STARTTLS for account email.")

    if purpose == "verify":
        title = "Confirm your ULTRON email address"
        introduction = (
            "Open ULTRON and paste this one-time verification code to activate "
            "your account."
        )
        action = "Verification code"
    elif purpose == "reset":
        title = "Reset your ULTRON password"
        introduction = (
            "Open ULTRON and paste this one-time recovery code to choose a new "
            "password."
        )
        action = "Recovery code"
    else:
        raise ValueError("Unsupported email token purpose.")

    message = EmailMessage()
    message["Subject"] = title
    message["From"] = sender
    message["To"] = recipient
    message.set_content(
        f"{introduction}\n\n{action}:\n{token}\n\n"
        f"This one-time code expires in {TOKEN_TTL_MINUTES} minutes and can be "
        "used once. If you did not request it, you can ignore this message."
    )

    context = ssl.create_default_context()
    smtp: smtplib.SMTP | smtplib.SMTP_SSL
    try:
        if use_ssl:
            smtp = smtplib.SMTP_SSL(host, port, timeout=15, context=context)
        else:
            smtp = smtplib.SMTP(host, port, timeout=15)
            smtp.ehlo()
            if use_starttls:
                smtp.starttls(context=context)
                smtp.ehlo()

        with smtp:
            if username:
                smtp.login(username, password)
            smtp.send_message(message)
    except (OSError, smtplib.SMTPException) as error:
        # Never include transport details or credentials in an API response.
        raise RuntimeError("ULTRON could not deliver the account email.") from error


def _create_email_token(user_id: str, purpose: str) -> str:
    token = _new_token()
    now = _now()
    connection = _database_connection()
    try:
        connection.execute(
            "DELETE FROM email_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL",
            (user_id, purpose),
        )
        connection.execute(
            """
            INSERT INTO email_tokens (
                id, user_id, purpose, token_hash, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                uuid4().hex,
                user_id,
                purpose,
                _token_digest(token),
                _timestamp(now),
                _timestamp(now + timedelta(minutes=TOKEN_TTL_MINUTES)),
            ),
        )
        connection.commit()
    finally:
        connection.close()
    return token


def _remove_active_email_tokens(user_id: str, purpose: str) -> None:
    connection = _database_connection()
    try:
        connection.execute(
            "DELETE FROM email_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL",
            (user_id, purpose),
        )
        connection.commit()
    finally:
        connection.close()


def _issue_email_token(user: sqlite3.Row, purpose: str) -> bool:
    """Create and send an email token; never expose its secret to the API."""

    if not _smtp_configured():
        return False

    token = _create_email_token(user["id"], purpose)
    try:
        _send_auth_email(
            recipient=user["email"],
            purpose=purpose,
            token=token,
        )
    except RuntimeError:
        _remove_active_email_tokens(user["id"], purpose)
        raise
    return True


def _consume_email_token(token: str, purpose: str) -> sqlite3.Row | None:
    digest = _token_digest(str(token or "").strip())
    now = _timestamp()
    connection = _database_connection()
    try:
        row = connection.execute(
            """
            SELECT
                email_tokens.id AS token_id,
                email_tokens.expires_at AS token_expires_at,
                users.*
            FROM email_tokens
            JOIN users ON users.id = email_tokens.user_id
            WHERE email_tokens.token_hash = ?
              AND email_tokens.purpose = ?
              AND email_tokens.used_at IS NULL
              AND users.disabled_at IS NULL
            """,
            (digest, purpose),
        ).fetchone()

        if row is None:
            return None

        try:
            expired = _parse_timestamp(row["token_expires_at"]) <= _now()
        except (TypeError, ValueError):
            expired = True

        if expired:
            connection.execute(
                "UPDATE email_tokens SET used_at = ? WHERE id = ?",
                (now, row["token_id"]),
            )
            connection.commit()
            return None

        changed = connection.execute(
            "UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL",
            (now, row["token_id"]),
        ).rowcount
        connection.commit()
        return row if changed else None
    finally:
        connection.close()


def _get_user_by_email(email: str) -> sqlite3.Row | None:
    connection = _database_connection()
    try:
        return connection.execute(
            "SELECT * FROM users WHERE email = ?",
            (email,),
        ).fetchone()
    finally:
        connection.close()


def _find_user_for_token(token: str, *, touch: bool = True) -> sqlite3.Row | None:
    if not token or len(token) > 512:
        return None

    connection = _database_connection()
    try:
        row = connection.execute(
            """
            SELECT users.*, sessions.id AS session_id, sessions.expires_at
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ?
              AND sessions.revoked_at IS NULL
              AND users.disabled_at IS NULL
            """,
            (_token_digest(token),),
        ).fetchone()

        if row is None:
            return None

        try:
            expired = _parse_timestamp(row["expires_at"]) <= _now()
        except (TypeError, ValueError):
            expired = True

        if expired:
            connection.execute(
                "UPDATE sessions SET revoked_at = ? WHERE id = ?",
                (_timestamp(), row["session_id"]),
            )
            connection.commit()
            return None

        if touch:
            connection.execute(
                "UPDATE sessions SET last_seen_at = ? WHERE id = ?",
                (_timestamp(), row["session_id"]),
            )
            connection.commit()
        return row
    finally:
        connection.close()


def _bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, separator, token = authorization.strip().partition(" ")
    if not separator or scheme.casefold() != "bearer" or not token.strip():
        return None
    return token.strip()


_current_user: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "ultron_current_user",
    default=None,
)


def set_current_user(user: dict[str, Any] | None) -> contextvars.Token:
    """Set the request-local authenticated user for migrated route code."""

    return _current_user.set(user)


def reset_current_user(token: contextvars.Token) -> None:
    """Reset request-local authentication context after a request."""

    _current_user.reset(token)


def get_current_user() -> dict[str, Any] | None:
    """Return the request-local user without reading a request header."""

    return _current_user.get()


def optional_auth(authorization: str | None = Header(default=None)) -> dict[str, Any] | None:
    """FastAPI dependency for endpoints that can use an account when present."""

    token = _bearer_token(authorization)
    if not token:
        return None
    row = _find_user_for_token(token)
    return _safe_user(row) if row is not None else None


def require_auth(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """FastAPI dependency for routes that require a valid bearer session."""

    user = optional_auth(authorization)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sign in is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def require_verified_auth(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """FastAPI dependency for routes that require a confirmed email address."""

    user = require_auth(authorization)
    if not user["email_verified"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Confirm your email address before using this feature.",
        )
    return user


class AuthContextMiddleware:
    """Optional middleware that makes the bearer user available via a contextvar.

    It deliberately does not reject anonymous requests. Existing public routes
    keep working while progressively migrated handlers can use
    ``get_current_user()`` or an explicit dependency.
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        context_token = None
        if scope.get("type") == "http":
            header_map = {
                key.decode("latin-1").casefold(): value.decode("latin-1")
                for key, value in scope.get("headers", [])
            }
            raw_token = _bearer_token(header_map.get("authorization"))
            if raw_token:
                row = _find_user_for_token(raw_token)
                if row is not None:
                    context_token = set_current_user(_safe_user(row))
        try:
            await self.app(scope, receive, send)
        finally:
            if context_token is not None:
                reset_current_user(context_token)


_rate_lock = threading.Lock()
_rate_attempts: dict[str, deque[float]] = defaultdict(deque)
RATE_WINDOW_SECONDS = _env_int(
    "ULTRON_AUTH_RATE_WINDOW_SECONDS",
    15 * 60,
    minimum=60,
    maximum=24 * 60 * 60,
)
LOGIN_ATTEMPT_LIMIT = _env_int(
    "ULTRON_AUTH_LOGIN_ATTEMPT_LIMIT",
    8,
    minimum=3,
    maximum=100,
)
RESET_ATTEMPT_LIMIT = _env_int(
    "ULTRON_AUTH_RESET_ATTEMPT_LIMIT",
    5,
    minimum=2,
    maximum=50,
)


def _request_identity(request: Request, email: str = "") -> str:
    host = request.client.host if request.client else "local"
    email_digest = hashlib.sha256(email.encode("utf-8")).hexdigest()[:16]
    return f"{host}:{email_digest}"


def _rate_limit(kind: str, request: Request, *, email: str, limit: int) -> None:
    key = f"{kind}:{_request_identity(request, email)}"
    now = time.monotonic()
    with _rate_lock:
        attempts = _rate_attempts[key]
        cutoff = now - RATE_WINDOW_SECONDS
        while attempts and attempts[0] < cutoff:
            attempts.popleft()
        if len(attempts) >= limit:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many attempts. Try again later.",
                headers={"Retry-After": str(RATE_WINDOW_SECONDS)},
            )
        attempts.append(now)


class RegisterRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=_PASSWORD_MAX_LENGTH)
    display_name: str = Field(default="", max_length=160)


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=_PASSWORD_MAX_LENGTH)


class EmailRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)


class EmailTokenRequest(BaseModel):
    token: str = Field(min_length=16, max_length=512)


class PasswordResetRequest(EmailTokenRequest):
    password: str = Field(min_length=1, max_length=_PASSWORD_MAX_LENGTH)


router = APIRouter(prefix="/api/auth", tags=["authentication"])


@router.get("/config")
def auth_config() -> dict[str, Any]:
    """Expose safe client configuration only; never expose secrets or SMTP host."""

    return {
        "ok": True,
        "registration_enabled": ALLOW_REGISTRATION,
        "email_verification_required": REQUIRE_EMAIL_VERIFICATION,
        "smtp_configured": _smtp_configured(),
        "session_ttl_days": SESSION_TTL_DAYS,
        "password_min_length": PASSWORD_MIN_LENGTH,
    }


@router.post("/register", status_code=status.HTTP_201_CREATED)
def register(request: Request, data: RegisterRequest) -> dict[str, Any]:
    if not ALLOW_REGISTRATION:
        raise HTTPException(status_code=403, detail="Account registration is disabled.")
    if REQUIRE_EMAIL_VERIFICATION and not _smtp_configured():
        raise HTTPException(
            status_code=503,
            detail="Email verification is required, but email delivery is not configured.",
        )

    email = _normalize_email(data.email)
    password = _validate_password(data.password, email=email)
    _rate_limit("register", request, email=email, limit=LOGIN_ATTEMPT_LIMIT)
    now = _timestamp()
    user_id = uuid4().hex
    email_verified = 0 if REQUIRE_EMAIL_VERIFICATION else 1

    connection = _database_connection()
    try:
        connection.execute(
            """
            INSERT INTO users (
                id, email, display_name, password_hash, email_verified, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                email,
                _clean_display_name(data.display_name),
                _hash_password(password),
                email_verified,
                now,
                now,
            ),
        )
        connection.commit()
        user = connection.execute(
            "SELECT * FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    except sqlite3.IntegrityError as error:
        raise HTTPException(
            status_code=409,
            detail="An account with this email already exists.",
        ) from error
    finally:
        connection.close()

    if user is None:
        raise HTTPException(status_code=500, detail="ULTRON could not create the account.")

    try:
        get_user_data_dir(user_id)
        verification_sent = False
        if REQUIRE_EMAIL_VERIFICATION:
            verification_sent = _issue_email_token(user, "verify")
    except (OSError, RuntimeError) as error:
        # Do not leave an unverified account that cannot receive its initial
        # confirmation email. This is only reached when verification is on.
        if REQUIRE_EMAIL_VERIFICATION:
            connection = _database_connection()
            try:
                connection.execute("DELETE FROM users WHERE id = ?", (user_id,))
                connection.commit()
            finally:
                connection.close()
        raise HTTPException(
            status_code=502,
            detail="ULTRON could not complete account setup. Try again.",
        ) from error

    session = _create_session(
        user,
        request.headers.get("user-agent", ""),
    )
    session["verification_required"] = REQUIRE_EMAIL_VERIFICATION
    session["verification_email_sent"] = verification_sent
    return session


@router.post("/login")
def login(request: Request, data: LoginRequest) -> dict[str, Any]:
    email = _normalize_email(data.email)
    _rate_limit("login", request, email=email, limit=LOGIN_ATTEMPT_LIMIT)
    user = _get_user_by_email(email)

    # A fake scrypt verification prevents a timing distinction between an
    # unknown email and an incorrect password.
    password_hash = user["password_hash"] if user is not None else _DUMMY_PASSWORD_HASH
    valid_password = _verify_password(data.password, password_hash)
    if user is None or not valid_password or user["disabled_at"] is not None:
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    session = _create_session(
        user,
        request.headers.get("user-agent", ""),
    )
    session["verification_required"] = REQUIRE_EMAIL_VERIFICATION and not bool(user["email_verified"])
    session["verification_email_sent"] = False
    return session


@router.get("/me")
def me(user: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    return {"ok": True, "user": user}


@router.post("/logout")
def logout(authorization: str | None = Header(default=None)) -> dict[str, bool]:
    token = _bearer_token(authorization)
    if token:
        connection = _database_connection()
        try:
            connection.execute(
                "UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
                (_timestamp(), _token_digest(token)),
            )
            connection.commit()
        finally:
            connection.close()
    # Idempotent logout avoids exposing whether a session ever existed.
    return {"ok": True}


@router.post("/verify-email")
def verify_email(data: EmailTokenRequest) -> dict[str, Any]:
    user = _consume_email_token(data.token, "verify")
    if user is None:
        raise HTTPException(status_code=400, detail="This confirmation code is invalid or has expired.")

    connection = _database_connection()
    try:
        connection.execute(
            "UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?",
            (_timestamp(), user["id"]),
        )
        connection.commit()
    finally:
        connection.close()

    current = _get_user_by_email(user["email"])
    if current is None:
        raise HTTPException(status_code=404, detail="Account no longer exists.")
    return {"ok": True, "user": _safe_user(current)}


@router.post("/resend-verification")
def resend_verification(request: Request, data: EmailRequest) -> dict[str, Any]:
    email = _normalize_email(data.email)
    _rate_limit("resend-verification", request, email=email, limit=RESET_ATTEMPT_LIMIT)
    user = _get_user_by_email(email)
    if (
        user is not None
        and user["disabled_at"] is None
        and not bool(user["email_verified"])
        and _smtp_configured()
    ):
        try:
            _issue_email_token(user, "verify")
        except RuntimeError:
            # This route must not reveal account state or transport details.
            pass
    return {"ok": True, "message": "If an account needs confirmation, an email will be sent."}


@router.post("/request-password-reset")
def request_password_reset(request: Request, data: EmailRequest) -> dict[str, Any]:
    email = _normalize_email(data.email)
    _rate_limit("password-reset", request, email=email, limit=RESET_ATTEMPT_LIMIT)
    user = _get_user_by_email(email)
    if user is not None and user["disabled_at"] is None and _smtp_configured():
        try:
            _issue_email_token(user, "reset")
        except RuntimeError:
            # Preserve a non-enumerating response; the operator can inspect
            # SMTP configuration without exposing its details to clients.
            pass
    return {"ok": True, "message": "If that account exists, a reset email will be sent."}


@router.post("/reset-password")
def reset_password(data: PasswordResetRequest) -> dict[str, bool]:
    user = _consume_email_token(data.token, "reset")
    if user is None:
        raise HTTPException(status_code=400, detail="This recovery code is invalid or has expired.")

    password = _validate_password(data.password, email=user["email"])
    now = _timestamp()
    connection = _database_connection()
    try:
        connection.execute(
            "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
            (_hash_password(password), now, user["id"]),
        )
        # Revoke every session, including the one that may have requested the
        # reset. The person must explicitly sign in with the new password.
        connection.execute(
            "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
            (now, user["id"]),
        )
        connection.commit()
    finally:
        connection.close()
    return {"ok": True}
