"""Account-scoped, local-first 3D printer integration for ULTRON.

The desktop app must never turn a status refresh into a network scan or an
arbitrary serial-port probe.  This module therefore follows a deliberately
narrow model:

* listing USB ports is metadata-only;
* opening a USB port or contacting a LAN printer requires an explicit action;
* only a saved, account-local profile can be monitored afterwards;
* all network profiles are limited to a single configured LAN endpoint;
* API keys are not written to ULTRON JSON files (macOS Keychain when
  available, otherwise the current backend session only).

The service supports read-only telemetry for Marlin-compatible USB printers,
OctoPrint, and Klipper/Moonraker.  It intentionally does not send jobs,
movement commands, temperatures, or emergency commands.  Bambu printers use
an authenticated MQTT/TLS protocol and are represented as an external-slicer
workflow until a vendor-supported LAN integration is available.
"""

from __future__ import annotations

import ipaddress
import json
import os
import platform
import re
import socket
import stat
import subprocess
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

import serial
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from serial.tools import list_ports

from auth import get_current_user, get_user_data_dir


router = APIRouter(prefix="/api/printer", tags=["printer"])


# A profile describes a *telemetry transport*, not a promise that every
# printer from a brand can be controlled.  Keeping capabilities explicit lets
# the frontend present honest actions and prevents accidental write commands.
PRINTER_PROFILES: dict[str, dict[str, Any]] = {
    "generic-usb": {
        "id": "generic-usb",
        "name": "Generic USB serial printer",
        "transport": "usb",
        "available": True,
        "credentialRequired": False,
        "supports": ["read-status", "firmware-identification"],
        "limitations": "Select the serial port yourself. ULTRON sends only M115 and M27 after confirmation.",
    },
    "marlin-usb": {
        "id": "marlin-usb",
        "name": "Marlin / Elegoo / Neptune over USB",
        "transport": "usb",
        "available": True,
        "credentialRequired": False,
        "supports": ["read-status", "firmware-identification", "sd-progress"],
        "limitations": "The printer must expose a Marlin-compatible serial interface. USB opening can wake or reset some boards.",
    },
    "octoprint-local": {
        "id": "octoprint-local",
        "name": "OctoPrint on local Wi-Fi or Ethernet",
        "transport": "lan",
        "available": True,
        "credentialRequired": True,
        "supports": ["read-status", "job-progress", "temperatures"],
        "limitations": "Only one explicit private-LAN OctoPrint URL is queried. ULTRON does not discover hosts or upload jobs.",
    },
    "klipper-moonraker-local": {
        "id": "klipper-moonraker-local",
        "name": "Klipper / Moonraker on local Wi-Fi or Ethernet",
        "transport": "lan",
        "available": True,
        "credentialRequired": False,
        "supports": ["read-status", "job-progress", "temperatures"],
        "limitations": "Only one explicit private-LAN Moonraker URL is queried. A token is used when the Moonraker instance requires one.",
    },
    "bambu-lan": {
        "id": "bambu-lan",
        "name": "Bambu Lab LAN mode",
        "transport": "external-app",
        "available": False,
        "credentialRequired": True,
        "supports": ["open-bambu-studio"],
        "limitations": "Bambu LAN uses device-specific TLS/MQTT authentication and an access code. Use Bambu Studio from ULTRON's external-app connector; direct printer telemetry is not claimed here.",
    },
}

_USB_PROFILE_IDS = {"generic-usb", "marlin-usb"}
_LAN_PROFILE_IDS = {"octoprint-local", "klipper-moonraker-local"}
_USB_BAUD_RATES = {9600, 19200, 38400, 57600, 115200, 230400, 250000}
_STATUS_MIN_INTERVAL_SECONDS = 2.0
_HTTP_RESPONSE_LIMIT_BYTES = 512 * 1024
_HTTP_TIMEOUT_SECONDS = 4
_SERIAL_TIMEOUT_SECONDS = 0.35
_SERIAL_PROBE_TIMEOUT_SECONDS = 2.0
_CONFIG_FILENAME = "printer-connection.json"
_CONFIG_VERSION = 1
_CREDENTIAL_MAX_LENGTH = 4096
_USB_PORT_MAX_LENGTH = 512
_URL_MAX_LENGTH = 512

_PRINTER_KEYWORDS = (
    "elegoo",
    "neptune",
    "marlin",
    "klipper",
    "octoprint",
    "ch340",
    "ch341",
    "cp210",
    "usb serial",
    "usb-modem",
    "usbmodem",
    "usbserial",
)
_IGNORED_PORT_MARKERS = (
    "bluetooth",
    "debug-console",
    "debug console",
)
_FIRMWARE_MARKERS = (
    "firmware_name",
    "marlin",
    "klipper",
    "repetier",
    "smoothieware",
    "elegoo",
    "neptune",
)


class PrinterConfigRequest(BaseModel):
    """Persist one deliberately selected printer profile for the signed-in account."""

    profileId: str = Field(min_length=3, max_length=80)
    usbPort: str | None = Field(default=None, max_length=_USB_PORT_MAX_LENGTH)
    baudRate: int | None = Field(default=None, ge=1200, le=1_000_000)
    baseUrl: str | None = Field(default=None, max_length=_URL_MAX_LENGTH)
    monitoring: bool = False
    # Omitted means preserve the stored Keychain/session credential. An empty
    # value explicitly removes it.
    credential: str | None = Field(default=None, max_length=_CREDENTIAL_MAX_LENGTH)


class PrinterConnectionRequest(BaseModel):
    """Use an explicit profile configuration for a one-off test or connection."""

    profileId: str | None = Field(default=None, min_length=3, max_length=80)
    usbPort: str | None = Field(default=None, max_length=_USB_PORT_MAX_LENGTH)
    baudRate: int | None = Field(default=None, ge=1200, le=1_000_000)
    baseUrl: str | None = Field(default=None, max_length=_URL_MAX_LENGTH)
    credential: str | None = Field(default=None, max_length=_CREDENTIAL_MAX_LENGTH)


def _utc_now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _active_account_id() -> str:
    user = get_current_user()
    account_id = str((user or {}).get("id") or "").strip()
    if not account_id:
        raise HTTPException(status_code=401, detail="Sign in is required.")
    return account_id


def _config_path(account_id: str) -> Path:
    return get_user_data_dir(account_id) / _CONFIG_FILENAME


def _default_config() -> dict[str, Any]:
    return {
        "version": _CONFIG_VERSION,
        "profileId": None,
        "transport": None,
        "usbPort": None,
        "baudRate": 115200,
        "baseUrl": None,
        "monitoring": False,
        "updatedAt": None,
    }


def _read_config(account_id: str) -> dict[str, Any]:
    path = _config_path(account_id)
    config = _default_config()
    if not path.exists():
        return config

    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return config

    if not isinstance(loaded, Mapping):
        return config

    # Retain only the documented public fields. This makes old, manually
    # edited, or future files unable to inject data into runtime commands.
    for key in config:
        if key in loaded:
            config[key] = loaded[key]
    return config


def _write_config(account_id: str, config: Mapping[str, Any]) -> None:
    path = _config_path(account_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass

    safe_config = {
        "version": _CONFIG_VERSION,
        "profileId": config.get("profileId"),
        "transport": config.get("transport"),
        "usbPort": config.get("usbPort"),
        "baudRate": config.get("baudRate"),
        "baseUrl": config.get("baseUrl"),
        "monitoring": bool(config.get("monitoring")),
        "updatedAt": config.get("updatedAt"),
    }
    temporary = path.with_name(f".{path.name}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(safe_config, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        temporary.replace(path)
        path.chmod(0o600)
    except OSError as error:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise HTTPException(
            status_code=500,
            detail="ULTRON could not save this local printer profile.",
        ) from error


def _profile(profile_id: str | None) -> dict[str, Any]:
    profile = PRINTER_PROFILES.get(str(profile_id or "").strip())
    if profile is None:
        raise HTTPException(status_code=422, detail="Choose a supported printer profile.")
    return profile


def _safe_profile(profile: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": profile["id"],
        "name": profile["name"],
        "transport": profile["transport"],
        "available": bool(profile["available"]),
        "credentialRequired": bool(profile["credentialRequired"]),
        "supports": list(profile["supports"]),
        "limitations": profile["limitations"],
    }


def _port_text(port: Any) -> str:
    values = (
        getattr(port, "device", ""),
        getattr(port, "description", ""),
        getattr(port, "manufacturer", ""),
        getattr(port, "product", ""),
    )
    return " ".join(str(value or "") for value in values).casefold()


def _serial_port_records() -> list[dict[str, Any]]:
    """Return serial metadata only; never open or write to a device here."""

    records: list[dict[str, Any]] = []
    try:
        ports = list(list_ports.comports())
    except Exception:
        ports = []

    for port in ports:
        device = str(getattr(port, "device", "") or "").strip()
        if not device:
            continue
        haystack = _port_text(port)
        if any(marker in haystack for marker in _IGNORED_PORT_MARKERS):
            continue
        score = sum(10 for marker in _PRINTER_KEYWORDS if marker in haystack)
        records.append(
            {
                "device": device,
                "description": str(getattr(port, "description", "") or "").strip()[:180],
                "manufacturer": str(getattr(port, "manufacturer", "") or "").strip()[:120],
                "product": str(getattr(port, "product", "") or "").strip()[:120],
                "vid": f"{int(getattr(port, 'vid')):04x}" if getattr(port, "vid", None) is not None else None,
                "pid": f"{int(getattr(port, 'pid')):04x}" if getattr(port, "pid", None) is not None else None,
                "score": score,
                "recommended": score > 0,
            }
        )

    return sorted(records, key=lambda item: (-int(item["score"]), item["device"]))


def _assert_selected_usb_port(port: str) -> str:
    normalized = str(port or "").strip()
    if not normalized or "\x00" in normalized:
        raise HTTPException(status_code=422, detail="Choose a detected USB serial port.")
    current_ports = {item["device"] for item in _serial_port_records()}
    if normalized not in current_ports:
        raise HTTPException(
            status_code=409,
            detail="That USB port is not currently detected. Refresh the port list and choose it again.",
        )
    return normalized


def _safe_private_ip(address: str) -> bool:
    try:
        value = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    return bool(
        (value.is_private or value.is_loopback or value.is_link_local)
        and not value.is_multicast
        and not value.is_unspecified
        and not value.is_reserved
    )


def _resolve_private_lan_host(hostname: str, port: int) -> None:
    """Require every resolved destination to stay on the local network.

    A hostname is resolved once during validation. The actual HTTP helpers
    validate before each request too, which keeps accidental public URLs out of
    the local bridge without doing any host discovery.
    """

    try:
        records = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except OSError as error:
        raise HTTPException(
            status_code=422,
            detail="ULTRON could not resolve that local printer address.",
        ) from error

    addresses = {str(item[4][0]) for item in records if item and item[4]}
    if not addresses or any(not _safe_private_ip(address) for address in addresses):
        raise HTTPException(
            status_code=422,
            detail="Use a private LAN or loopback printer address, not a public network address.",
        )


def _normalize_lan_base_url(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw or len(raw) > _URL_MAX_LENGTH or "\x00" in raw:
        raise HTTPException(status_code=422, detail="Enter the local printer URL.")

    parsed = urlsplit(raw)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise HTTPException(
            status_code=422,
            detail="Use a plain local HTTP or HTTPS printer URL without credentials in the address.",
        )

    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as error:
        raise HTTPException(status_code=422, detail="The printer URL port is invalid.") from error
    if not 1 <= port <= 65535:
        raise HTTPException(status_code=422, detail="The printer URL port is invalid.")

    hostname = parsed.hostname.rstrip(".").casefold()
    if not hostname:
        raise HTTPException(status_code=422, detail="The printer URL hostname is invalid.")
    _resolve_private_lan_host(hostname, port)

    # Drop a trailing slash but retain a user-selected local reverse-proxy path.
    path = parsed.path.rstrip("/")
    netloc = hostname
    if parsed.port is not None:
        netloc = f"{hostname}:{parsed.port}"
    return urlunsplit((parsed.scheme, netloc, path, "", ""))


def _normalise_baud_rate(value: int | None) -> int:
    rate = int(value or 115200)
    if rate not in _USB_BAUD_RATES:
        raise HTTPException(
            status_code=422,
            detail="Choose a standard serial speed supported by the selected printer.",
        )
    return rate


def _merge_connection_config(
    existing: Mapping[str, Any],
    request: PrinterConfigRequest | PrinterConnectionRequest,
    *,
    require_profile: bool,
    validate_usb_port: bool,
) -> dict[str, Any]:
    """Normalize API input into a narrow runtime configuration."""

    supplied = request.model_fields_set
    profile_id = (
        request.profileId
        if "profileId" in supplied and request.profileId is not None
        else existing.get("profileId")
    )
    if require_profile and not profile_id:
        raise HTTPException(status_code=422, detail="Choose a printer profile first.")
    profile = _profile(profile_id)

    if not profile["available"]:
        raise HTTPException(status_code=409, detail=str(profile["limitations"]))

    result: dict[str, Any] = {
        "version": _CONFIG_VERSION,
        "profileId": profile["id"],
        "transport": profile["transport"],
        "usbPort": None,
        "baudRate": 115200,
        "baseUrl": None,
        "monitoring": bool(existing.get("monitoring", False)),
        "updatedAt": _utc_now(),
    }

    if profile["transport"] == "usb":
        raw_port = request.usbPort if "usbPort" in supplied else existing.get("usbPort")
        if raw_port:
            result["usbPort"] = (
                _assert_selected_usb_port(raw_port) if validate_usb_port else str(raw_port).strip()
            )
        if require_profile and not result["usbPort"]:
            raise HTTPException(status_code=422, detail="Choose a detected USB serial port.")
        raw_baud = request.baudRate if "baudRate" in supplied else existing.get("baudRate")
        result["baudRate"] = _normalise_baud_rate(raw_baud)

    elif profile["transport"] == "lan":
        raw_url = request.baseUrl if "baseUrl" in supplied else existing.get("baseUrl")
        if raw_url:
            result["baseUrl"] = _normalize_lan_base_url(raw_url)
        if require_profile and not result["baseUrl"]:
            raise HTTPException(status_code=422, detail="Enter the local printer URL.")
        if isinstance(request, PrinterConfigRequest):
            result["monitoring"] = bool(request.monitoring)

    return result


def _keychain_service(profile_id: str) -> str:
    return f"com.lumacaonta.ultron.printer.{profile_id}"


def _keychain_account(account_id: str) -> str:
    return f"account-{account_id}"


_ephemeral_credentials: dict[tuple[str, str], str] = {}


def _can_use_macos_keychain() -> bool:
    return platform.system() == "Darwin" and bool(shutil_which("security"))


def shutil_which(command: str) -> str | None:
    # Kept local to avoid importing another module only for an optional macOS
    # feature and to make this tiny platform boundary easy to mock in tests.
    for directory in os.getenv("PATH", "").split(os.pathsep):
        candidate = Path(directory) / command
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def _save_credential(account_id: str, profile_id: str, credential: str) -> str:
    clean = str(credential or "").strip()
    key = (account_id, profile_id)
    if not clean:
        _ephemeral_credentials.pop(key, None)
        if _can_use_macos_keychain():
            subprocess.run(
                ["security", "delete-generic-password", "-a", _keychain_account(account_id), "-s", _keychain_service(profile_id)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
        return "none"

    if len(clean) > _CREDENTIAL_MAX_LENGTH or "\x00" in clean:
        raise HTTPException(status_code=422, detail="The printer credential is invalid.")

    if _can_use_macos_keychain():
        try:
            result = subprocess.run(
                [
                    "security", "add-generic-password",
                    "-U",
                    "-a",
                    _keychain_account(account_id),
                    "-s",
                    _keychain_service(profile_id),
                    "-w",
                    clean,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=8,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            result = None
        if result is not None and result.returncode == 0:
            _ephemeral_credentials.pop(key, None)
            return "keychain"

    # Do not silently put a printer API key into plaintext JSON on platforms
    # without an OS credential store. The connection can still be tested in
    # this running local session.
    _ephemeral_credentials[key] = clean
    return "session"


def _load_credential(account_id: str, profile_id: str) -> tuple[str | None, str]:
    key = (account_id, profile_id)
    if key in _ephemeral_credentials:
        return _ephemeral_credentials[key], "session"
    if not _can_use_macos_keychain():
        return None, "none"
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-a", _keychain_account(account_id), "-s", _keychain_service(profile_id), "-w"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None, "none"
    value = result.stdout.strip() if result.returncode == 0 else ""
    return (value or None), "keychain" if value else "none"


def _safe_config_view(account_id: str, config: Mapping[str, Any]) -> dict[str, Any]:
    profile_id = config.get("profileId")
    profile = PRINTER_PROFILES.get(str(profile_id or ""))
    _credential, credential_mode = _load_credential(account_id, str(profile_id or "")) if profile_id else (None, "none")
    return {
        "configured": bool(profile),
        "profile": _safe_profile(profile) if profile else None,
        "profileId": profile_id if profile else None,
        "transport": config.get("transport") if profile else None,
        "usbPort": config.get("usbPort") if profile else None,
        "baudRate": config.get("baudRate") if profile else None,
        "baseUrl": config.get("baseUrl") if profile else None,
        "monitoring": bool(config.get("monitoring")) if profile else False,
        "hasCredential": credential_mode != "none",
        "credentialStorage": credential_mode,
        "updatedAt": config.get("updatedAt") if profile else None,
    }


def _firmware_response_is_valid(response: str) -> bool:
    lowered = response.casefold()
    return any(marker in lowered for marker in _FIRMWARE_MARKERS)


def _open_serial_port(port: str, baud_rate: int) -> serial.Serial:
    """Open one selected port with modem control disabled before opening it."""

    connection = serial.Serial()
    connection.port = port
    connection.baudrate = baud_rate
    connection.timeout = _SERIAL_TIMEOUT_SECONDS
    connection.write_timeout = _SERIAL_TIMEOUT_SECONDS
    connection.dtr = False
    connection.rts = False
    connection.open()
    return connection


def _read_serial_lines(connection: serial.Serial, *, duration: float) -> str:
    deadline = time.monotonic() + max(0.1, duration)
    chunks: list[str] = []
    while time.monotonic() < deadline:
        try:
            if connection.in_waiting:
                chunks.append(connection.readline().decode("utf-8", errors="replace"))
                continue
        except (OSError, serial.SerialException):
            break
        time.sleep(0.03)
    return "".join(chunks)[-4000:]


def _serial_probe(port: str, baud_rate: int) -> tuple[serial.Serial, str]:
    try:
        connection = _open_serial_port(port, baud_rate)
        try:
            connection.reset_input_buffer()
        except (OSError, serial.SerialException):
            pass
        connection.write(b"\nM115\n")
        connection.flush()
        firmware = _read_serial_lines(connection, duration=_SERIAL_PROBE_TIMEOUT_SECONDS)
        if not _firmware_response_is_valid(firmware):
            connection.close()
            raise HTTPException(
                status_code=502,
                detail="The selected USB device did not identify as a supported printer firmware.",
            )
        return connection, firmware.strip()[-1000:]
    except HTTPException:
        raise
    except (OSError, serial.SerialException) as error:
        raise HTTPException(
            status_code=503,
            detail="ULTRON could not open the selected USB printer port.",
        ) from error


def _parse_marlin_status(raw: str) -> tuple[str, float | None]:
    lowered = raw.casefold()
    if "not sd printing" in lowered or "not printing" in lowered:
        status = "IDLE"
    elif "sd printing" in lowered or "printing" in lowered:
        status = "PRINTING"
    else:
        status = "CONNECTED"
    match = re.search(r"(\d+)\s*/\s*(\d+)", raw)
    if not match:
        return status, None
    total = int(match.group(2))
    return status, round((int(match.group(1)) / total) * 100, 1) if total > 0 else None


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def _local_json_get(url: str, headers: Mapping[str, str]) -> dict[str, Any]:
    """Fetch one bounded JSON document from the already validated local URL."""

    parsed = urlsplit(url)
    if not parsed.hostname:
        raise HTTPException(status_code=422, detail="The printer URL is invalid.")
    try:
        _resolve_private_lan_host(
            parsed.hostname,
            parsed.port or (443 if parsed.scheme == "https" else 80),
        )
    except HTTPException:
        raise

    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "ULTRON-local-desktop/1.1 (printer telemetry)",
            **dict(headers),
        },
        method="GET",
    )
    try:
        with build_opener(_NoRedirect()).open(request, timeout=_HTTP_TIMEOUT_SECONDS) as response:
            raw = response.read(_HTTP_RESPONSE_LIMIT_BYTES + 1)
            if len(raw) > _HTTP_RESPONSE_LIMIT_BYTES:
                raise ValueError("response too large")
            data = json.loads(raw.decode("utf-8"))
    except HTTPError as error:
        if error.code in {301, 302, 303, 307, 308}:
            raise HTTPException(status_code=502, detail="The local printer rejected a redirect.") from error
        raise HTTPException(status_code=502, detail="The local printer did not accept the telemetry request.") from error
    except (URLError, OSError, TimeoutError, UnicodeDecodeError, ValueError):
        raise HTTPException(status_code=503, detail="ULTRON could not reach the configured local printer.")

    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="The local printer returned an invalid telemetry response.")
    return data


def _request_headers(profile_id: str, credential: str | None) -> dict[str, str]:
    if not credential:
        return {}
    if profile_id == "octoprint-local":
        return {"X-Api-Key": credential}
    if profile_id == "klipper-moonraker-local":
        return {"Authorization": f"Bearer {credential}"}
    return {}


def _network_status(config: Mapping[str, Any], credential: str | None) -> dict[str, Any]:
    profile_id = str(config["profileId"])
    base_url = str(config["baseUrl"])
    headers = _request_headers(profile_id, credential)

    if profile_id == "octoprint-local":
        if not credential:
            raise HTTPException(status_code=409, detail="Add the OctoPrint API key before connecting.")
        printer = _local_json_get(f"{base_url}/api/printer", headers)
        job = _local_json_get(f"{base_url}/api/job", headers)
        state = printer.get("state") if isinstance(printer.get("state"), Mapping) else {}
        flags = state.get("flags") if isinstance(state.get("flags"), Mapping) else {}
        if flags.get("printing"):
            status = "PRINTING"
        elif flags.get("paused"):
            status = "PAUSED"
        elif flags.get("error"):
            status = "ERROR"
        elif flags.get("operational"):
            status = "IDLE"
        else:
            status = str(state.get("text") or "CONNECTED").upper()[:80]
        progress_data = job.get("progress") if isinstance(job.get("progress"), Mapping) else {}
        progress_raw = progress_data.get("completion")
        try:
            progress = round(max(0.0, min(100.0, float(progress_raw))), 1)
        except (TypeError, ValueError):
            progress = None
        job_data = job.get("job") if isinstance(job.get("job"), Mapping) else {}
        file_data = job_data.get("file") if isinstance(job_data.get("file"), Mapping) else {}
        return {
            "connected": True,
            "status": status,
            "progress": progress,
            "firmware": "OctoPrint",
            "job": str(file_data.get("name") or "")[:240] or None,
            "raw": "OctoPrint telemetry accepted.",
        }

    if profile_id == "klipper-moonraker-local":
        info = _local_json_get(f"{base_url}/printer/info", headers)
        objects = _local_json_get(
            f"{base_url}/printer/objects/query?print_stats&virtual_sdcard",
            headers,
        )
        info_result = info.get("result") if isinstance(info.get("result"), Mapping) else {}
        result = objects.get("result") if isinstance(objects.get("result"), Mapping) else {}
        stats = result.get("status") if isinstance(result.get("status"), Mapping) else result
        print_stats = stats.get("print_stats") if isinstance(stats.get("print_stats"), Mapping) else {}
        virtual_sd = stats.get("virtual_sdcard") if isinstance(stats.get("virtual_sdcard"), Mapping) else {}
        status = str(print_stats.get("state") or info_result.get("state") or "connected").upper()[:80]
        progress_raw = virtual_sd.get("progress")
        try:
            progress = round(max(0.0, min(100.0, float(progress_raw) * 100)), 1)
        except (TypeError, ValueError):
            progress = None
        return {
            "connected": True,
            "status": status,
            "progress": progress,
            "firmware": "Klipper / Moonraker",
            "job": str(print_stats.get("filename") or "")[:240] or None,
            "raw": "Moonraker telemetry accepted.",
        }

    raise HTTPException(status_code=422, detail="The selected network printer profile is unsupported.")


@dataclass
class _RuntimeConnection:
    profile_id: str
    transport: str
    serial_connection: serial.Serial | None = None
    firmware: str | None = None
    connected_at: float = field(default_factory=time.monotonic)
    last_checked_at: float = 0.0
    status: dict[str, Any] = field(default_factory=dict)


_runtime_lock = threading.RLock()
_runtime_connections: dict[str, _RuntimeConnection] = {}


def _close_runtime_connection(account_id: str) -> bool:
    with _runtime_lock:
        connection = _runtime_connections.pop(account_id, None)
    if connection is None:
        return False
    try:
        if connection.serial_connection is not None:
            connection.serial_connection.close()
    except (OSError, serial.SerialException):
        pass
    return True


def _offline_status(config: Mapping[str, Any], *, detail: str = "NOT CONNECTED") -> dict[str, Any]:
    profile_id = config.get("profileId")
    return {
        "connected": False,
        "profileId": profile_id,
        "transport": config.get("transport"),
        "port": config.get("usbPort"),
        "baseUrl": config.get("baseUrl"),
        "firmware": None,
        "status": detail,
        "progress": None,
        "job": None,
        "raw": "",
        "lastCheckedAt": None,
        "monitoring": bool(config.get("monitoring")),
    }


def _status_view(config: Mapping[str, Any], status: Mapping[str, Any], *, checked_at: float | None = None) -> dict[str, Any]:
    return {
        "connected": bool(status.get("connected")),
        "profileId": config.get("profileId"),
        "transport": config.get("transport"),
        "port": config.get("usbPort"),
        "baseUrl": config.get("baseUrl"),
        "firmware": status.get("firmware"),
        "status": status.get("status") or "CONNECTED",
        "progress": status.get("progress"),
        "job": status.get("job"),
        "raw": str(status.get("raw") or "")[-1000:],
        "lastCheckedAt": _utc_now() if checked_at is not None else None,
        "monitoring": bool(config.get("monitoring")),
    }


def _serial_status(runtime: _RuntimeConnection) -> dict[str, Any]:
    connection = runtime.serial_connection
    if connection is None or not connection.is_open:
        return {"connected": False, "status": "NOT CONNECTED"}
    try:
        connection.reset_input_buffer()
        connection.write(b"M27\n")
        connection.flush()
        raw = _read_serial_lines(connection, duration=0.45)
    except (OSError, serial.SerialException):
        return {"connected": False, "status": "NOT CONNECTED"}
    status, progress = _parse_marlin_status(raw)
    return {
        "connected": True,
        "status": status,
        "progress": progress,
        "firmware": runtime.firmware,
        "raw": raw,
    }


def _connect(account_id: str, config: Mapping[str, Any], credential: str | None) -> dict[str, Any]:
    profile_id = str(config.get("profileId") or "")
    profile = _profile(profile_id)
    if not profile["available"]:
        raise HTTPException(status_code=409, detail=str(profile["limitations"]))

    _close_runtime_connection(account_id)
    if profile["transport"] == "usb":
        port = _assert_selected_usb_port(str(config.get("usbPort") or ""))
        serial_connection, firmware = _serial_probe(port, _normalise_baud_rate(config.get("baudRate")))
        runtime = _RuntimeConnection(
            profile_id=profile_id,
            transport="usb",
            serial_connection=serial_connection,
            firmware=firmware,
        )
        initial = {
            "connected": True,
            "status": "CONNECTED",
            "progress": None,
            "firmware": firmware,
            "raw": firmware,
        }
        runtime.status = initial
        runtime.last_checked_at = time.monotonic()
        with _runtime_lock:
            _runtime_connections[account_id] = runtime
        return _status_view(config, initial, checked_at=runtime.last_checked_at)

    if profile["transport"] == "lan":
        initial = _network_status(config, credential)
        runtime = _RuntimeConnection(profile_id=profile_id, transport="lan")
        runtime.status = initial
        runtime.last_checked_at = time.monotonic()
        with _runtime_lock:
            _runtime_connections[account_id] = runtime
        return _status_view(config, initial, checked_at=runtime.last_checked_at)

    raise HTTPException(status_code=409, detail=str(profile["limitations"]))


def _test_connection(config: Mapping[str, Any], credential: str | None) -> dict[str, Any]:
    profile = _profile(str(config.get("profileId") or ""))
    if profile["transport"] == "usb":
        port = _assert_selected_usb_port(str(config.get("usbPort") or ""))
        connection, firmware = _serial_probe(port, _normalise_baud_rate(config.get("baudRate")))
        try:
            return _status_view(
                config,
                {
                    "connected": True,
                    "status": "READY",
                    "progress": None,
                    "firmware": firmware,
                    "raw": firmware,
                },
                checked_at=time.monotonic(),
            )
        finally:
            try:
                connection.close()
            except (OSError, serial.SerialException):
                pass
    if profile["transport"] == "lan":
        return _status_view(config, _network_status(config, credential), checked_at=time.monotonic())
    raise HTTPException(status_code=409, detail=str(profile["limitations"]))


def _credentials_for_request(
    account_id: str,
    profile_id: str,
    request: PrinterConfigRequest | PrinterConnectionRequest,
) -> tuple[str | None, str]:
    if "credential" in request.model_fields_set:
        supplied = request.credential
        if supplied is not None:
            return str(supplied).strip() or None, "request"
    return _load_credential(account_id, profile_id)


@router.get("/profiles")
def list_printer_profiles() -> dict[str, Any]:
    """List telemetry capability without attempting USB or network discovery."""

    _active_account_id()
    return {"profiles": [_safe_profile(item) for item in PRINTER_PROFILES.values()]}


@router.get("/ports")
def list_printer_ports() -> dict[str, Any]:
    """List detected serial device metadata; no selected port is opened."""

    _active_account_id()
    return {"ports": _serial_port_records(), "scanMode": "metadata-only"}


@router.get("/config")
def get_printer_config() -> dict[str, Any]:
    account_id = _active_account_id()
    return _safe_config_view(account_id, _read_config(account_id))


@router.put("/config")
def save_printer_config(request: PrinterConfigRequest) -> dict[str, Any]:
    """Persist one account-local profile without persisting plaintext keys."""

    account_id = _active_account_id()
    existing = _read_config(account_id)
    config = _merge_connection_config(
        existing,
        request,
        require_profile=True,
        validate_usb_port=True,
    )
    if "credential" in request.model_fields_set:
        _save_credential(account_id, str(config["profileId"]), request.credential or "")
    _write_config(account_id, config)
    _close_runtime_connection(account_id)
    return {"ok": True, "config": _safe_config_view(account_id, config)}


@router.post("/test-connection")
def test_printer_connection(request: PrinterConnectionRequest) -> dict[str, Any]:
    """Run one user-triggered read-only USB/LAN connection test without saving it."""

    account_id = _active_account_id()
    existing = _read_config(account_id)
    config = _merge_connection_config(
        existing,
        request,
        require_profile=True,
        validate_usb_port=True,
    )
    credential, _mode = _credentials_for_request(account_id, str(config["profileId"]), request)
    return {"ok": True, "test": _test_connection(config, credential)}


@router.post("/connect")
def connect_printer() -> dict[str, Any]:
    """Open the selected profile after an explicit user command."""

    account_id = _active_account_id()
    config = _read_config(account_id)
    if not config.get("profileId"):
        raise HTTPException(status_code=409, detail="Configure a printer profile before connecting.")
    credential, _mode = _load_credential(account_id, str(config["profileId"]))
    return {"ok": True, "status": _connect(account_id, config, credential)}


@router.post("/disconnect")
def disconnect_printer() -> dict[str, Any]:
    """Close the active account's USB session and stop its polling state."""

    account_id = _active_account_id()
    return {"ok": True, "disconnected": _close_runtime_connection(account_id)}


@router.get("/status")
def printer_status() -> dict[str, Any]:
    """Return cached telemetry unless the user enabled a connected profile monitor.

    This endpoint never discovers ports, opens a new USB connection, or probes
    a network range.  At most one already-connected configured target is
    polled every two seconds.
    """

    account_id = _active_account_id()
    config = _read_config(account_id)
    if not config.get("profileId"):
        return _offline_status(config, detail="NOT CONFIGURED")

    with _runtime_lock:
        runtime = _runtime_connections.get(account_id)
    if runtime is None or runtime.profile_id != config.get("profileId"):
        return _offline_status(config, detail="NOT CONNECTED")

    now = time.monotonic()
    if bool(config.get("monitoring")) and now - runtime.last_checked_at >= _STATUS_MIN_INTERVAL_SECONDS:
        try:
            if runtime.transport == "usb":
                checked = _serial_status(runtime)
            else:
                credential, _mode = _load_credential(account_id, runtime.profile_id)
                checked = _network_status(config, credential)
            runtime.status = checked
            runtime.last_checked_at = now
        except HTTPException:
            # Do not expose local-network transport detail in background UI
            # refreshes. The explicit test action returns a clear, safe error.
            runtime.status = {"connected": False, "status": "UNREACHABLE"}
            runtime.last_checked_at = now

    if not runtime.status.get("connected"):
        _close_runtime_connection(account_id)
        return _offline_status(config, detail=str(runtime.status.get("status") or "NOT CONNECTED"))
    return _status_view(config, runtime.status, checked_at=runtime.last_checked_at)


def close_all_printer_connections() -> None:
    """Release serial handles on controlled shutdown or in isolated tests."""

    with _runtime_lock:
        account_ids = list(_runtime_connections)
    for account_id in account_ids:
        _close_runtime_connection(account_id)
