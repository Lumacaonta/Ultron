"""Local integration with macOS Mail and the system mail/browser handlers.

Mail data is queried only by a user-triggered request.  Outbound mail is
prepared as a visible ULTRON review card and is transmitted only after the
user presses its explicit Send control.  Gmail authentication remains owned
by macOS Internet Accounts and Mail.app. Windows can open Gmail or a reviewed
``mailto:`` draft in the person's own browser or default mail application.
"""

from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import webbrowser
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode


_MAIL_APP_PATHS = (
    Path("/System/Applications/Mail.app"),
    Path("/Applications/Mail.app"),
)
_MAX_INBOX_LIMIT = 50
_MAX_RECIPIENTS = 20
_MAX_SUBJECT_LENGTH = 500
_MAX_BODY_LENGTH = 10_000
_EMAIL_PATTERN = re.compile(
    r"^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$"
)


class EmailServiceError(RuntimeError):
    """A safe error message that can be returned to the local UI."""


def _is_macos() -> bool:
    return platform.system() == "Darwin"


def _mail_app_available() -> bool:
    return _is_macos() and any(
        path.exists() for path in _MAIL_APP_PATHS
    )


def _friendly_osascript_error(stderr: str) -> str:
    detail = (stderr or "").lower()

    if "not authorized" in detail or "not permitted" in detail:
        return (
            "ULTRON needs permission to control Mail. "
            "Allow it in macOS Privacy & Security > Automation."
        )

    if "application isn't running" in detail:
        return "Mail is not available on this Mac."

    return "Mail could not be reached. Open Mail and try again."


def _run_jxa(
    script: str,
    *,
    timeout: int = 12,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run a small JavaScript for Automation script and parse its JSON.

    The scripts are fixed strings in this module.  User input is never
    interpolated into AppleScript/JXA source.
    """

    if not _is_macos() or not shutil.which("osascript"):
        raise EmailServiceError(
            "Mail integration is available only on macOS."
        )

    try:
        environment = None

        if payload is not None:
            environment = os.environ.copy()
            environment["ULTRON_EMAIL_PAYLOAD"] = json.dumps(
                payload,
                ensure_ascii=False,
            )

        process = subprocess.run(
            ["osascript", "-l", "JavaScript", "-e", script],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env=environment,
        )
    except subprocess.TimeoutExpired as error:
        raise EmailServiceError(
            "Mail did not respond in time."
        ) from error
    except OSError as error:
        raise EmailServiceError(
            "Mail could not be opened."
        ) from error

    if process.returncode != 0:
        raise EmailServiceError(
            _friendly_osascript_error(process.stderr)
        )

    try:
        result = json.loads(process.stdout.strip() or "{}")
    except json.JSONDecodeError as error:
        raise EmailServiceError(
            "Mail returned an unreadable response."
        ) from error

    if not isinstance(result, dict):
        raise EmailServiceError("Mail returned an invalid response.")

    return result


_STATUS_SCRIPT = r'''
const Mail = Application("Mail");

function asText(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function safe(callable, fallback) {
  try {
    return callable();
  } catch (_) {
    return fallback;
  }
}

// Do not suppress an Automation-permission error: the local UI needs to be
// able to tell the user how to grant access to Mail.
const accounts = Mail.accounts();
const result = accounts.map((account) => ({
  name: safe(() => asText(account.name()), ""),
  addresses: safe(
    () => account.emailAddresses().map((address) => asText(address)),
    []
  ),
})).filter((account) => account.name || account.addresses.length);

JSON.stringify({
  running: safe(() => Boolean(Mail.running()), false),
  accounts: result,
});
'''


def get_email_status() -> dict[str, Any]:
    """Return Mail availability and configured account metadata.

    This is called only by the explicit ``/api/email/status`` request.  It
    does not fetch individual messages or their content.
    """

    if not _mail_app_available():
        return {
            "ok": False,
            "available": False,
            "configured": False,
            "running": False,
            "accounts": [],
            "error": "Mail.app is not installed on this Mac.",
        }

    try:
        result = _run_jxa(_STATUS_SCRIPT)
    except EmailServiceError as error:
        return {
            "ok": False,
            "available": True,
            "configured": None,
            "running": False,
            "accounts": [],
            "error": str(error),
        }

    accounts = result.get("accounts")
    if not isinstance(accounts, list):
        accounts = []

    return {
        "ok": True,
        "available": True,
        "configured": bool(accounts),
        "running": bool(result.get("running")),
        "accounts": accounts,
        "error": None,
    }


def _inbox_script(
    limit: int,
    include_body: bool = False,
) -> str:
    """Return fixed JXA source with a validated numeric result limit."""

    body_field = ""

    if include_body:
        body_field = '''
    body: safe(() => asText(message.content()).slice(0, 5000), ""),'''

    return f'''
const Mail = Application("Mail");
const limit = {limit};

function asText(value) {{
  if (value === undefined || value === null) return "";
  return String(value);
}}

function safe(callable, fallback) {{
  try {{
    return callable();
  }} catch (_) {{
    return fallback;
  }}
}}

function asDate(value) {{
  try {{
    return value ? value.toISOString() : null;
  }} catch (_) {{
    return asText(value) || null;
  }}
}}

function asBoolean(value) {{
  return value === true || String(value).toLowerCase() === "true";
}}

// Surface an Automation-permission error to Python instead of treating it as
// an empty inbox.
const accounts = Mail.accounts();
let result;
if (!accounts.length) {{
  result = {{messages: []}};
}} else {{
  const inbox = Mail.inbox();
  const messages = safe(() => inbox.messages(), []).slice(0, limit);
  const rows = messages.map((message) => ({
    sender: safe(() => asText(message.sender()), ""),
    subject: safe(() => asText(message.subject()), ""),
    receivedAt: safe(() => asDate(message.dateReceived()), null),
    read: safe(() => asBoolean(message.readStatus()), null),
    account: safe(
      () => asText(message.mailbox().account().name()),
      ""
    ),
    {body_field}
  }));
  result = {{messages: rows}};
}}
JSON.stringify(result);
'''


def list_inbox(
    limit: int = 20,
    *,
    include_body: bool = False,
) -> dict[str, Any]:
    """Read requested Mail headers, and bodies only when explicitly asked.

    The caller must invoke this function directly; there is no automatic
    inbox polling.
    """

    if not _mail_app_available():
        raise EmailServiceError(
            "Mail.app is not installed on this Mac."
        )

    safe_limit = max(1, min(int(limit), _MAX_INBOX_LIMIT))
    result = _run_jxa(
        _inbox_script(
            safe_limit,
            include_body=include_body,
        )
    )
    messages = result.get("messages")

    if not isinstance(messages, list):
        messages = []

    return {
        "ok": True,
        "limit": safe_limit,
        "messages": messages,
    }


def get_unread_messages(
    limit: int = 8,
    *,
    include_body: bool = False,
) -> dict[str, Any]:
    """Return unread Mail messages after an explicit user request.

    This is intentionally on-demand.  ULTRON never polls a mailbox in the
    background and never marks messages as read while inspecting them.
    """

    result = list_inbox(
        _MAX_INBOX_LIMIT,
        include_body=include_body,
    )

    unread = [
        message
        for message in result["messages"]
        if message.get("read") is False
    ]

    safe_limit = max(1, min(int(limit), _MAX_INBOX_LIMIT))

    return {
        "ok": True,
        "count": len(unread),
        "messages": unread[:safe_limit],
    }


def open_email(provider: str = "mail") -> dict[str, Any]:
    """Open local Mail or Gmail; neither action reads or sends messages."""

    target = (provider or "mail").strip().lower()

    if target not in {"mail", "gmail"}:
        raise EmailServiceError(
            "Choose either 'mail' or 'gmail'."
        )

    if target == "mail":
        if _is_macos():
            if not _mail_app_available():
                raise EmailServiceError(
                    "Mail.app is not installed on this Mac."
                )
            command = ["open", "-a", "Mail"]
            label = "Mail"
        else:
            try:
                if not webbrowser.open("mailto:"):
                    raise OSError("No default mail application is available.")
            except OSError as error:
                raise EmailServiceError(
                    "Unable to open the default mail application."
                ) from error
            return {
                "ok": True,
                "provider": target,
                "message": "Opening the default mail application.",
            }
    else:
        if not _is_macos():
            try:
                if not webbrowser.open_new_tab("https://mail.google.com"):
                    raise OSError("No browser is available.")
            except OSError as error:
                raise EmailServiceError("Unable to open Gmail.") from error
            return {
                "ok": True,
                "provider": target,
                "message": "Opening Gmail in your browser.",
            }
        command = ["open", "https://mail.google.com"]
        label = "Gmail"

    try:
        subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as error:
        raise EmailServiceError(
            f"Unable to open {label}."
        ) from error

    return {
        "ok": True,
        "provider": target,
        "message": f"Opening {label}.",
    }


def open_gmail_setup() -> dict[str, Any]:
    """Open the macOS account sheet used to authenticate Gmail.

    The user signs in directly with Google in macOS.  ULTRON never receives
    or stores a Google password or an OAuth refresh token; Mail.app keeps the
    account and its authorization in the system account store.
    """

    if not _is_macos():
        try:
            if not webbrowser.open_new_tab("https://accounts.google.com/"):
                raise OSError("No browser is available.")
        except OSError as error:
            raise EmailServiceError("Unable to open Google sign-in.") from error
        return {
            "ok": True,
            "message": "Google sign-in opened in your browser. Sign in to Gmail there, then return to ULTRON.",
        }

    try:
        subprocess.Popen(
            [
                "open",
                "x-apple.systempreferences:com.apple.Internet-Accounts-Settings.extension",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as error:
        raise EmailServiceError(
            "Unable to open macOS Internet Accounts."
        ) from error

    return {
        "ok": True,
        "message": (
            "Internet Accounts opened. Add Google, sign in, then return to "
            "ULTRON and choose Check status."
        ),
    }


def _normalise_recipients(recipients: list[str]) -> list[str]:
    cleaned: list[str] = []

    for raw_recipient in recipients:
        for recipient in str(raw_recipient or "").split(","):
            address = recipient.strip()

            if not address:
                continue

            if not _EMAIL_PATTERN.fullmatch(address):
                raise EmailServiceError(
                    "Each recipient must be a valid email address."
                )

            if address.lower() not in {
                item.lower() for item in cleaned
            }:
                cleaned.append(address)

            if len(cleaned) > _MAX_RECIPIENTS:
                raise EmailServiceError(
                    f"A draft can include up to {_MAX_RECIPIENTS} recipients."
                )

    return cleaned


_SEND_SCRIPT = r'''
ObjC.import("stdlib");
const payload = JSON.parse($.getenv("ULTRON_EMAIL_PAYLOAD"));
const Mail = Application("Mail");

const message = Mail.OutgoingMessage({
  subject: payload.subject,
  content: payload.body,
  visible: false,
});

payload.recipients.forEach((address) => {
  message.toRecipients.push(
    Mail.Recipient({address})
  );
});

Mail.outgoingMessages.push(message);
message.send();

JSON.stringify({ok: true});
'''


def send_email(
    recipients: list[str],
    subject: str = "",
    body: str = "",
) -> dict[str, Any]:
    """Send an approved message through the user's configured Mail account.

    This function is only reached from ULTRON's explicit Send control.  The
    account, including a Gmail account, stays managed by macOS Mail.
    """

    if not _mail_app_available():
        raise EmailServiceError(
            "Mail.app is not installed on this Mac."
        )

    safe_recipients = _normalise_recipients(recipients)
    safe_subject = str(subject or "").strip()
    safe_body = str(body or "")

    if not safe_recipients:
        raise EmailServiceError(
            "Choose at least one recipient before sending."
        )

    if len(safe_subject) > _MAX_SUBJECT_LENGTH:
        raise EmailServiceError(
            f"The subject must be at most {_MAX_SUBJECT_LENGTH} characters."
        )

    if len(safe_body) > _MAX_BODY_LENGTH:
        raise EmailServiceError(
            f"The body must be at most {_MAX_BODY_LENGTH} characters."
        )

    _run_jxa(
        _SEND_SCRIPT,
        payload={
            "recipients": safe_recipients,
            "subject": safe_subject,
            "body": safe_body,
        },
        timeout=20,
    )

    return {
        "ok": True,
        "recipients": safe_recipients,
        "message": "Transmission sent through Mail.",
    }


def compose_draft(
    recipients: list[str],
    subject: str = "",
    body: str = "",
) -> dict[str, Any]:
    """Open a client-side draft using ``mailto:``; it never sends mail."""

    safe_recipients = _normalise_recipients(recipients)
    safe_subject = str(subject or "").strip()
    safe_body = str(body or "")

    if len(safe_subject) > _MAX_SUBJECT_LENGTH:
        raise EmailServiceError(
            f"The subject must be at most {_MAX_SUBJECT_LENGTH} characters."
        )

    if len(safe_body) > _MAX_BODY_LENGTH:
        raise EmailServiceError(
            f"The draft body must be at most {_MAX_BODY_LENGTH} characters."
        )

    recipient_path = ",".join(
        quote(address, safe="@._+-")
        for address in safe_recipients
    )
    query = urlencode(
        {
            "subject": safe_subject,
            "body": safe_body,
        },
        quote_via=quote,
    )
    mailto_url = f"mailto:{recipient_path}?{query}"

    try:
        if _is_macos():
            subprocess.Popen(
                ["open", mailto_url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        elif not webbrowser.open(mailto_url):
            raise OSError("No default mail application is available.")
    except OSError as error:
        raise EmailServiceError("Unable to open a mail draft.") from error

    return {
        "ok": True,
        "recipients": safe_recipients,
        "message": (
            "Draft opened in your mail client. Review it and send it "
            "yourself if you choose."
        ),
    }
