"""Safe, account-scoped handoff to local macOS fabrication software.

ULTRON never accepts an executable path from the renderer at launch time.  A
person first chooses an ``.app`` bundle with the macOS application picker; the
resolved bundle is stored in their private profile.  Later file handoff uses a
stable application id and a model which was selected through the Model Deck.
This keeps the feature useful for Cura, Bambu Studio and any other local tool
without turning the loopback API into an arbitrary command runner.
"""

from __future__ import annotations

import json
import os
import platform
import re
import subprocess
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from auth import get_current_user, get_user_data_dir


router = APIRouter(prefix="/api/models", tags=["models"])

_APP_CONFIG_NAME = "external-apps.json"
_APP_CONFIG_VERSION = 1
_MAX_APPS = 32
_MAX_LABEL_LENGTH = 80
_SAFE_APP_ID = re.compile(r"^(?:known|custom)-[a-z0-9-]{2,120}$")

# Only conventional install locations are inspected.  This is a metadata check
# and it never starts an application.  Custom applications are selected by the
# operator and kept in their own local profile.
_KNOWN_APPS: tuple[dict[str, Any], ...] = (
    {
        "id": "known-cura",
        "name": "UltiMaker Cura",
        "kind": "Slicer",
        "appNames": ("UltiMaker Cura.app", "Ultimaker Cura.app", "Cura.app"),
        "supports": ("STL", "OBJ", "3MF", "G-CODE"),
    },
    {
        "id": "known-bambu-studio",
        "name": "Bambu Studio",
        "kind": "Printer studio",
        "appNames": ("BambuStudio.app", "Bambu Studio.app"),
        "supports": ("STL", "OBJ", "3MF", "BAMBU"),
    },
    {
        "id": "known-orca-slicer",
        "name": "OrcaSlicer",
        "kind": "Slicer",
        "appNames": ("OrcaSlicer.app", "Orca Slicer.app"),
        "supports": ("STL", "OBJ", "3MF", "G-CODE"),
    },
    {
        "id": "known-prusa-slicer",
        "name": "PrusaSlicer",
        "kind": "Slicer",
        "appNames": ("PrusaSlicer.app",),
        "supports": ("STL", "OBJ", "3MF", "G-CODE"),
    },
    {
        "id": "known-lychee-slicer",
        "name": "Lychee Slicer",
        "kind": "Resin slicer",
        "appNames": ("Lychee Slicer.app",),
        "supports": ("STL", "OBJ", "3MF", "CTB", "PHOTON"),
    },
    {
        "id": "known-freecad",
        "name": "FreeCAD",
        "kind": "CAD",
        "appNames": ("FreeCAD.app",),
        "supports": ("STEP", "IGES", "STL", "OBJ"),
    },
    {
        "id": "known-openscad",
        "name": "OpenSCAD",
        "kind": "CAD",
        "appNames": ("OpenSCAD.app",),
        "supports": ("SCAD", "STL", "DXF", "SVG"),
    },
)


class ExternalAppPickRequest(BaseModel):
    """Optional display label for a native application selected by the person."""

    label: str = Field(default="", max_length=_MAX_LABEL_LENGTH)


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
    return (Path("/Applications"), Path.home() / "Applications")


def _resolve_app_bundle(value: str | Path) -> Path | None:
    try:
        candidate = Path(value).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    if candidate.suffix.casefold() != ".app" or not candidate.is_dir():
        return None
    # A real macOS app bundle includes Info.plist.  This avoids handing a file
    # to `open -a` after a crafted directory was chosen.
    if platform.system() == "Darwin" and not (candidate / "Contents" / "Info.plist").is_file():
        return None
    return candidate


def _known_app_path(definition: Mapping[str, Any]) -> Path | None:
    for root in _application_search_roots():
        for filename in definition.get("appNames", ()):  # fixed source data
            app = _resolve_app_bundle(root / str(filename))
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
    app = _resolve_app_bundle(item["path"])
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
            raise HTTPException(status_code=404, detail=f"{definition['name']} was not found in Applications.")
        return app, _public_known_app(definition)

    for item in _read_config(account_id):
        if item["id"] != normalized:
            continue
        app = _resolve_app_bundle(item["path"])
        if app is None:
            raise HTTPException(status_code=404, detail="The linked local application is no longer available.")
        return app, _public_custom_app(item)

    raise HTTPException(status_code=404, detail="That application is not linked to this local account.")


def _choose_application() -> str | None:
    if platform.system() != "Darwin":
        raise HTTPException(status_code=501, detail="Choose-an-application is currently available in the macOS desktop build.")

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
    app = _resolve_app_bundle(selected_path)
    if app is None:
        raise HTTPException(status_code=422, detail="Choose a valid macOS .app bundle.")
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


@router.get("/apps")
def list_external_apps() -> dict[str, Any]:
    """List known and operator-linked local apps without opening any of them."""

    return {"apps": _all_apps_for_account(_active_account_id())}


@router.post("/apps/pick")
def pick_external_app(request: ExternalAppPickRequest) -> dict[str, Any]:
    """Open the native picker and store a private link to one local .app bundle."""

    account_id = _active_account_id()
    selected = _choose_application()
    if not selected:
        return {"ok": False, "cancelled": True}
    return {"ok": True, "app": _remember_custom_app(account_id, selected, request.label)}


@router.post("/open-external")
def open_model_in_external_app(request: ExternalAppOpenRequest) -> dict[str, Any]:
    """Handoff an already-selected Model Deck file to a linked macOS app."""

    account_id = _active_account_id()
    # Import lazily: main imports this router before it defines model helpers.
    from main import _resolve_model_file  # noqa: PLC0415

    model = _resolve_model_file(request.path)
    app, public_app = _resolve_linked_app(account_id, request.appId)

    if platform.system() != "Darwin":
        raise HTTPException(status_code=501, detail="External application handoff is currently available in the macOS desktop build.")

    try:
        result = subprocess.run(
            ["open", "-a", str(app), str(model)],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise HTTPException(status_code=502, detail="ULTRON could not hand the selected file to that application.") from error
    if result.returncode != 0:
        raise HTTPException(status_code=502, detail="ULTRON could not hand the selected file to that application.")

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

    if platform.system() != "Darwin":
        raise HTTPException(status_code=501, detail="Opening linked applications is currently available in the macOS desktop build.")

    try:
        result = subprocess.run(
            ["open", "-a", str(app)],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise HTTPException(status_code=502, detail="ULTRON could not open that linked application.") from error
    if result.returncode != 0:
        raise HTTPException(status_code=502, detail="ULTRON could not open that linked application.")

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
