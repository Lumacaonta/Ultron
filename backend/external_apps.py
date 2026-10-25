"""Safe, account-scoped handoff to local fabrication software.

The Electron shell owns the native picker on macOS and Windows. It sends the
choice to this module through a per-launch secret that the renderer never
receives. Later handoff accepts only a stable app id and a Model Deck file that
was selected during the current account session. This keeps links to Cura,
Bambu Studio and other local tools useful without exposing an arbitrary command
runner through the loopback API.
"""

from __future__ import annotations

import hmac
import json
import os
import platform
import re
import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user, get_user_data_dir


router = APIRouter(prefix="/api/models", tags=["models"])

_APP_CONFIG_NAME = "external-apps.json"
_APP_CONFIG_VERSION = 2
_MAX_APPS = 32
_MAX_LABEL_LENGTH = 80
_SAFE_APP_ID = re.compile(r"^(?:known|custom)-[a-z0-9-]{2,120}$")

# Only conventional install locations are inspected. This is a metadata check
# and never starts an application. Custom applications must be chosen with the
# native desktop dialog and are stored in the current account's private profile.
_KNOWN_APPS: tuple[dict[str, Any], ...] = (
    {
        "id": "known-cura",
        "name": "UltiMaker Cura",
        "kind": "Slicer",
        "macNames": ("UltiMaker Cura.app", "Ultimaker Cura.app", "Cura.app"),
        "windowsPatterns": (
            "UltiMaker Cura*/UltiMaker-Cura.exe",
            "Ultimaker Cura*/Cura.exe",
            "Cura*/Cura.exe",
        ),
        "supports": ("STL", "OBJ", "3MF", "G-CODE"),
    },
    {
        "id": "known-bambu-studio",
        "name": "Bambu Studio",
        "kind": "Printer studio",
        "macNames": ("BambuStudio.app", "Bambu Studio.app"),
        "windowsPatterns": (
            "Bambu Studio/Bambu Studio.exe",
            "Bambu Studio*/Bambu Studio.exe",
            "BambuStudio/BambuStudio.exe",
        ),
        "supports": ("STL", "OBJ", "3MF", "BAMBU"),
    },
    {
        "id": "known-orca-slicer",
        "name": "OrcaSlicer",
        "kind": "Slicer",
        "macNames": ("OrcaSlicer.app", "Orca Slicer.app"),
        "windowsPatterns": (
            "OrcaSlicer/OrcaSlicer.exe",
            "OrcaSlicer*/OrcaSlicer.exe",
            "Orca Slicer*/OrcaSlicer.exe",
        ),
        "supports": ("STL", "OBJ", "3MF", "G-CODE"),
    },
    {
        "id": "known-prusa-slicer",
        "name": "PrusaSlicer",
        "kind": "Slicer",
        "macNames": ("PrusaSlicer.app",),
        "windowsPatterns": (
            "PrusaSlicer/PrusaSlicer.exe",
            "PrusaSlicer*/PrusaSlicer.exe",
        ),
        "supports": ("STL", "OBJ", "3MF", "G-CODE"),
    },
    {
        "id": "known-lychee-slicer",
        "name": "Lychee Slicer",
        "kind": "Resin slicer",
        "macNames": ("Lychee Slicer.app",),
        "windowsPatterns": (
            "LycheeSlicer*/LycheeSlicer.exe",
            "Lychee Slicer*/LycheeSlicer.exe",
        ),
        "supports": ("STL", "OBJ", "3MF", "CTB", "PHOTON"),
    },
    {
        "id": "known-freecad",
        "name": "FreeCAD",
        "kind": "CAD",
        "macNames": ("FreeCAD.app",),
        "windowsPatterns": ("FreeCAD*/bin/FreeCAD.exe",),
        "supports": ("STEP", "IGES", "STL", "OBJ"),
    },
    {
        "id": "known-openscad",
        "name": "OpenSCAD",
        "kind": "CAD",
        "macNames": ("OpenSCAD.app",),
        "windowsPatterns": ("OpenSCAD*/openscad.exe",),
        "supports": ("SCAD", "STL", "DXF", "SVG"),
    },
)


class ExternalAppPickRequest(BaseModel):
    """Optional display label for a native application selected by the person."""

    label: str = Field(default="", max_length=_MAX_LABEL_LENGTH)


class ExternalAppRegisterRequest(ExternalAppPickRequest):
    """A native desktop selection that must carry its verified local path."""

    path: str = Field(min_length=1, max_length=4096)


class ExternalAppOpenRequest(BaseModel):
    """Open one user-selected Model Deck asset in one linked local app."""

    path: str = Field(min_length=1, max_length=4096)
    appId: str = Field(min_length=3, max_length=140)


def _active_account_id() -> str:
    user = get_current_user()
    account_id = str((user or {}).get("id") or "").strip()
    if not account_id:
        raise HTTPException(status_code=401, detail="Sign in is required.")
    return account_id


def _config_path(account_id: str) -> Path:
    return get_user_data_dir(account_id) / _APP_CONFIG_NAME


def _private_write(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    temporary = path.with_name(f".{path.name}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        temporary.replace(path)
        path.chmod(0o600)
    except OSError as error:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise HTTPException(status_code=500, detail="ULTRON could not save the external software link.") from error


def _read_config(account_id: str) -> list[dict[str, str]]:
    path = _config_path(account_id)
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(payload, Mapping) or not isinstance(payload.get("apps"), list):
        return []

    apps: list[dict[str, str]] = []
    for item in payload["apps"][:_MAX_APPS]:
        if not isinstance(item, Mapping):
            continue
        app_id = str(item.get("id") or "").strip()
        path_value = str(item.get("path") or "").strip()
        label = str(item.get("label") or "").strip()
        if not _SAFE_APP_ID.fullmatch(app_id) or not path_value or "\x00" in path_value:
            continue
        apps.append({"id": app_id, "path": path_value, "label": label[:_MAX_LABEL_LENGTH]})
    return apps


def _write_config(account_id: str, apps: list[Mapping[str, str]]) -> None:
    safe_apps = [
        {"id": str(item["id"]), "path": str(item["path"]), "label": str(item.get("label") or "")[:_MAX_LABEL_LENGTH]}
        for item in apps[:_MAX_APPS]
    ]
    _private_write(
        _config_path(account_id),
        {"version": _APP_CONFIG_VERSION, "apps": safe_apps},
    )


def _application_search_roots() -> tuple[Path, ...]:
    """Return conventional roots only; never enumerate a whole local disk."""

    if platform.system() == "Darwin":
        return (Path("/Applications"), Path.home() / "Applications")

    if platform.system() == "Windows":
        roots: list[Path] = []
        for variable in ("ProgramFiles", "ProgramW6432", "LOCALAPPDATA"):
            value = os.getenv(variable, "").strip()
            if not value:
                continue
            root = Path(value)
            roots.append(root)
            # Per-user desktop installers conventionally use this fixed
            # directory. It is a bounded known location, never a disk scan.
            if variable == "LOCALAPPDATA":
                roots.append(root / "Programs")
        return tuple(dict.fromkeys(roots))

    return (Path.home() / ".local" / "share" / "applications", Path("/usr/share/applications"))


def _resolve_application(value: str | Path) -> Path | None:
    """Validate a native executable or macOS bundle selected by the operator."""

    try:
        candidate = Path(value).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return None

    system = platform.system()
    if system == "Darwin":
        if candidate.suffix.casefold() != ".app" or not candidate.is_dir():
            return None
        if not (candidate / "Contents" / "Info.plist").is_file():
            return None
        return candidate

    if system == "Windows":
        if candidate.suffix.casefold() != ".exe" or not candidate.is_file():
            return None
        return candidate

    if not candidate.is_file() or not os.access(candidate, os.X_OK):
        return None
    return candidate


def _known_app_path(definition: Mapping[str, Any]) -> Path | None:
    if platform.system() == "Darwin":
        for root in _application_search_roots():
            for filename in definition.get("macNames", ()):  # fixed source data
                app = _resolve_application(root / str(filename))
                if app is not None:
                    return app
        return None

    if platform.system() == "Windows":
        for root in _application_search_roots():
            for pattern in definition.get("windowsPatterns", ()):  # fixed source data
                try:
                    matches = root.glob(str(pattern))
                except OSError:
                    continue
                for match in matches:
                    app = _resolve_application(match)
                    if app is not None:
                        return app
    return None


def _public_known_app(definition: Mapping[str, Any]) -> dict[str, Any]:
    app = _known_app_path(definition)
    return {
        "id": definition["id"],
        "name": definition["name"],
        "kind": definition["kind"],
        "available": app is not None,
        "configured": False,
        "launchesFiles": app is not None,
        "supports": list(definition["supports"]),
    }


def _public_custom_app(item: Mapping[str, str]) -> dict[str, Any]:
    app = _resolve_application(item["path"])
    name = (item.get("label") or (app.stem if app else Path(item["path"]).stem) or "External application").strip()
    return {
        "id": item["id"],
        "name": name[:_MAX_LABEL_LENGTH],
        "kind": "Linked local application",
        "available": app is not None,
        "configured": True,
        "launchesFiles": app is not None,
        "supports": [],
    }


def _all_apps_for_account(account_id: str) -> list[dict[str, Any]]:
    known = [_public_known_app(item) for item in _KNOWN_APPS]
    custom = [_public_custom_app(item) for item in _read_config(account_id)]
    return known + custom


def _resolve_linked_app(account_id: str, app_id: str) -> tuple[Path, dict[str, Any]]:
    normalized = str(app_id or "").strip().casefold()
    if not _SAFE_APP_ID.fullmatch(normalized):
        raise HTTPException(status_code=422, detail="Choose a linked local application.")

    for definition in _KNOWN_APPS:
        if definition["id"] != normalized:
            continue
        app = _known_app_path(definition)
        if app is None:
            raise HTTPException(status_code=404, detail=f"{definition['name']} was not found in the usual local application locations.")
        return app, _public_known_app(definition)

    for item in _read_config(account_id):
        if item["id"] != normalized:
            continue
        app = _resolve_application(item["path"])
        if app is None:
            raise HTTPException(status_code=404, detail="The linked local application is no longer available.")
        return app, _public_custom_app(item)

    raise HTTPException(status_code=404, detail="That application is not linked to this local account.")


def _choose_application() -> str | None:
    if platform.system() != "Darwin":
        raise HTTPException(status_code=501, detail="Use the ULTRON desktop application selector on this platform.")

    chooser_script = '''
try
    set chosenApp to choose application with prompt "Scegli il programma da collegare a ULTRON"
    return POSIX path of chosenApp
on error number -128
    return ""
end try
'''
    try:
        result = subprocess.run(
            ["osascript", "-e", chooser_script],
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None
    except OSError as error:
        raise HTTPException(status_code=500, detail="ULTRON could not open the macOS application picker.") from error
    selected = result.stdout.strip()
    return selected or None


def _safe_label(value: str, fallback: str) -> str:
    clean = " ".join(str(value or "").split())
    clean = clean.replace("\x00", "")[:_MAX_LABEL_LENGTH]
    return clean or fallback[:_MAX_LABEL_LENGTH]


def _remember_custom_app(account_id: str, selected_path: str, label: str) -> dict[str, Any]:
    app = _resolve_application(selected_path)
    if app is None:
        raise HTTPException(status_code=422, detail="Choose a valid local application.")
    resolved_path = str(app)
    apps = _read_config(account_id)
    current = next((item for item in apps if item["path"] == resolved_path), None)
    if current is None:
        if len(apps) >= _MAX_APPS:
            raise HTTPException(status_code=409, detail="Remove an external application before linking another one.")
        current = {
            "id": f"custom-{uuid4().hex}",
            "path": resolved_path,
            "label": _safe_label(label, app.stem),
        }
        apps.append(current)
    elif label.strip():
        current["label"] = _safe_label(label, app.stem)
    _write_config(account_id, apps)
    return _public_custom_app(current)


def _require_native_desktop_picker(header_value: str | None) -> None:
    """Require the secret known only by Electron's main process and backend."""

    expected = os.getenv("ULTRON_DESKTOP_PICKER_SECRET", "").strip()
    supplied = str(header_value or "").strip()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="The native desktop selector is unavailable in this session.",
        )
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(
            status_code=403,
            detail="The local desktop selection was not verified.",
        )


def _launch_application(app: Path, model: Path | None = None) -> None:
    """Start one already-validated local application without a shell."""

    system = platform.system()
    if system == "Darwin":
        command = ["open", "-a", str(app)]
        if model is not None:
            command.append(str(model))
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise HTTPException(
                status_code=502,
                detail="ULTRON could not open that linked application.",
            ) from error
        if result.returncode != 0:
            raise HTTPException(
                status_code=502,
                detail="ULTRON could not open that linked application.",
            )
        return

    if system == "Windows":
        command = [str(app)]
        if model is not None:
            command.append(str(model))
        try:
            subprocess.Popen(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=False,
            )
        except OSError as error:
            raise HTTPException(
                status_code=502,
                detail="ULTRON could not open that linked application.",
            ) from error
        return

    raise HTTPException(
        status_code=501,
        detail="External application handoff is currently available in the macOS and Windows desktop builds.",
    )


@router.get("/apps")
def list_external_apps() -> dict[str, Any]:
    """List known and operator-linked local apps without opening any of them."""

    return {"apps": _all_apps_for_account(_active_account_id())}


@router.post("/apps/pick")
def pick_external_app(request: ExternalAppPickRequest) -> dict[str, Any]:
    """macOS development fallback when Electron's picker is unavailable."""

    account_id = _active_account_id()
    selected = _choose_application()
    if not selected:
        return {"ok": False, "cancelled": True}
    return {"ok": True, "app": _remember_custom_app(account_id, selected, request.label)}


@router.post("/apps/register")
def register_external_app(
    request: ExternalAppRegisterRequest,
    http_request: Request,
) -> dict[str, Any]:
    """Persist one Electron-selected app link for the current local account."""

    _require_native_desktop_picker(
        http_request.headers.get("X-Ultron-Desktop-Picker")
    )
    account_id = _active_account_id()
    return {
        "ok": True,
        "app": _remember_custom_app(account_id, request.path, request.label),
    }


@router.post("/open-external")
def open_model_in_external_app(request: ExternalAppOpenRequest) -> dict[str, Any]:
    """Handoff an already-selected Model Deck file to a linked local app."""

    account_id = _active_account_id()
    # Import lazily: main imports this router before it defines model helpers.
    from main import _resolve_model_file  # noqa: PLC0415

    model = _resolve_model_file(request.path)
    app, public_app = _resolve_linked_app(account_id, request.appId)

    _launch_application(app, model)

    return {"ok": True, "application": public_app["name"], "model": model.name}


@router.post("/apps/{app_id}/launch")
def launch_external_app(app_id: str) -> dict[str, Any]:
    """Open one linked local application without passing it a file.

    This is useful when a person wants to manage their own printer directly in
    Bambu Studio, Cura, or another vendor application.  The renderer still
    provides only a stable id; the executable bundle is resolved from the
    signed-in account's saved link or the small known-app allowlist.
    """

    account_id = _active_account_id()
    app, public_app = _resolve_linked_app(account_id, app_id)

    _launch_application(app)

    return {"ok": True, "application": public_app["name"]}


@router.delete("/apps/{app_id}")
def forget_external_app(app_id: str) -> dict[str, Any]:
    """Remove one operator-linked custom application from this account only."""

    account_id = _active_account_id()
    normalized = str(app_id or "").strip().casefold()
    if not normalized.startswith("custom-") or not _SAFE_APP_ID.fullmatch(normalized):
        raise HTTPException(status_code=422, detail="Only a custom linked application can be removed.")
    apps = _read_config(account_id)
    retained = [item for item in apps if item["id"] != normalized]
    if len(retained) == len(apps):
        raise HTTPException(status_code=404, detail="That application is not linked to this local account.")
    _write_config(account_id, retained)
    return {"ok": True}
