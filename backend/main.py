import hmac
import json
import mimetypes
import os
import platform
import re
import subprocess
import sqlite3
import stat
import threading
import time
import webbrowser
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen
from uuid import uuid4

import psutil
from dotenv import load_dotenv
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi import FastAPI, HTTPException, Request as FastAPIRequest
from auth import (
    AuthContextMiddleware,
    get_current_user,
    get_user_data_dir,
    require_auth,
    require_verified_auth,
    router as auth_router,
)
from skills_api import router as skills_router
from skills_engine import execute_skill_for_message, get_skill
from printer_service import close_all_printer_connections, router as printer_router
from external_apps import router as external_apps_router
from email_service import (
    EmailServiceError,
    compose_draft,
    get_email_status,
    get_unread_messages,
    list_inbox,
    open_email,
    open_gmail_setup,
    send_email,
)

from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from memory import (
    store_memories,
    get_memory_graph,
    get_memory_count,
)

load_dotenv(
    dotenv_path=Path(__file__).resolve().with_name(".env")
)



OLLAMA_URL = os.getenv(
    "ULTRON_OLLAMA_URL",
    "http://127.0.0.1:11434/api/chat",
).strip()
OLLAMA_MODEL = os.getenv("ULTRON_OLLAMA_MODEL", "llama3.2").strip()
BACKEND_LAUNCH_SECRET = os.getenv("ULTRON_LAUNCH_SECRET", "").strip()
BACKEND_INSTANCE_ID = os.getenv("ULTRON_LAUNCH_INSTANCE_ID", "").strip()
BACKEND_DESKTOP_PICKER_SECRET = os.getenv(
    "ULTRON_DESKTOP_PICKER_SECRET", ""
).strip()
ENABLE_API_DOCS = os.getenv("ULTRON_ENABLE_API_DOCS", "").strip().lower() in {
    "1",
    "true",
    "yes",
}

# Global Position is deliberately an explicit UI action.  The Nominatim public
# endpoint permits light, user-triggered use, but asks applications to identify
# themselves, stay below one request per second, cache responses, and keep a
# practical provider escape hatch.  Results live only in process memory: an
# address search never becomes part of an ULTRON account profile until the
# person confirms a position in Settings.
LOCATION_PROVIDER_URL = (
    os.getenv("ULTRON_GEOCODER_URL", "https://nominatim.openstreetmap.org/search")
    .strip()
    or "https://nominatim.openstreetmap.org/search"
)
LOCATION_LOOKUP_INTERVAL_SECONDS = 1.05
LOCATION_CACHE_TTL_SECONDS = 15 * 60
LOCATION_CACHE_LIMIT = 64
LOCATION_RESPONSE_LIMIT_BYTES = 512 * 1024
_location_lookup_lock = threading.Lock()
_location_lookup_last_request_at = 0.0
_location_lookup_cache: OrderedDict[str, tuple[float, list[dict[str, object]]]] = OrderedDict()


def _active_account() -> dict:
    """Return the request-local account after the API guard has authenticated it."""

    user = get_current_user()
    if not user or not str(user.get("id") or "").strip():
        raise HTTPException(status_code=401, detail="Sign in is required.")
    return user


def _active_account_id() -> str:
    return str(_active_account()["id"])


def _active_profile_dir() -> Path:
    return get_user_data_dir(_active_account_id())


def _memory_subject() -> str:
    """Give first-person memories a safe, account-local identity label."""

    display_name = " ".join(
        str(_active_account().get("display_name") or "").strip().split()
    )
    return (display_name[:80] or "OPERATOR").upper()

def ask_ollama(
    message: str,
    language: str = "Italian",
    history: list[dict] | None = None,
) -> str:

    messages = [
        {
            "role": "system",
            "content": (
                "You are ULTRON, a private local AI assistant for the signed-in operator. "
                f"Answer in {language}. "
                "Be natural, direct, and useful. "
                "For normal questions, explain things clearly. "
                "Do not mention internal reasoning. "
                "Do not pretend to have performed actions you did not perform."
            ),
        },
    ]

    for turn in (history or [])[-8:]:
        if not isinstance(turn, dict):
            continue

        role = "assistant" if turn.get("role") == "assistant" else "user"
        content = str(turn.get("text") or "").strip()

        if content:
            messages.append({
                "role": role,
                "content": content[:1600],
            })

    messages.append({
        "role": "user",
        "content": message,
    })

    payload = {
        "model": OLLAMA_MODEL,

        "messages": messages,

        "stream": False,
        "keep_alive": "10m",

        "options": {
            "temperature": 0.6,
            "num_predict": 384,
        },
    }

    request = Request(
        OLLAMA_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
        },
        method="POST",
    )

    with urlopen(
        request,
        timeout=90,
    ) as response:

        data = json.loads(
            response.read().decode("utf-8")
        )

    message_data = data.get(
        "message",
        {}
    )

    reply = str(
        message_data.get(
            "content",
            ""
        )
    ).strip()

    if not reply:
        raise RuntimeError(
            "Ollama returned an empty response."
        )

    return reply



MEMORY_MODEL = os.getenv("ULTRON_MEMORY_MODEL", "llama3.2").strip()


def extract_explicit_memories(
    message: str
):
    """
    Fast deterministic extraction for explicit
    first-person statements.

    This supplements the LLM extractor so that
    important multi-value statements are not lost.
    """

    import re

    text = message.strip()
    subject = _memory_subject()

    memories = []

    # --------------------------------------------------------
    # Learning / studying
    # --------------------------------------------------------

    patterns = [
        (
            r"(?:sto|sono)\s+(?:imparando|studiando)\s+(.+)",
            "learning",
        ),
        (
            r"(?:i\s*am|i'm)\s+(?:learning|studying)\s+(.+)",
            "learning",
        ),
    ]

    for pattern, predicate in patterns:

        match = re.search(
            pattern,
            text,
            re.IGNORECASE,
        )

        if not match:
            continue

        values_text = match.group(1).strip()

        # Remove final punctuation.
        values_text = values_text.rstrip(".!?")

        # Split "Python e Docker" / "Python and Docker".
        parts = re.split(
            r"\s+(?:e|and)\s+|,\s*",
            values_text,
            flags=re.IGNORECASE,
        )

        for part in parts:

            value = part.strip(
                " .,!?"
            )

            if not value:
                continue

            if len(value) > 80:
                continue

            memories.append({
                "subject": subject,
                "predicate": predicate,
                "object": value,
                "salience": 0.72,
            })

        if memories:
            return memories

    # --------------------------------------------------------
    # Likes
    # --------------------------------------------------------

    patterns = [
        (
            r"mi piace\s+(.+)",
            "likes",
        ),
        (
            r"i\s+like\s+(.+)",
            "likes",
        ),
    ]

    for pattern, predicate in patterns:

        match = re.search(
            pattern,
            text,
            re.IGNORECASE,
        )

        if not match:
            continue

        values_text = match.group(1).rstrip(
            ".!?"
        )

        parts = re.split(
            r"\s+(?:e|and)\s+|,\s*",
            values_text,
            flags=re.IGNORECASE,
        )

        for part in parts:

            value = part.strip(
                " .,!?"
            )

            if value:
                memories.append({
                    "subject": subject,
                    "predicate": predicate,
                    "object": value,
                    "salience": 0.64,
                })

        if memories:
            return memories

    # --------------------------------------------------------
    # Uses / owns
    # --------------------------------------------------------

    patterns = [
        (
            r"(?:uso|utilizzo)\s+(.+)",
            "uses",
        ),
        (
            r"i\s+use\s+(.+)",
            "uses",
        ),
    ]

    for pattern, predicate in patterns:

        match = re.search(
            pattern,
            text,
            re.IGNORECASE,
        )

        if not match:
            continue

        values_text = match.group(1).rstrip(
            ".!?"
        )

        parts = re.split(
            r"\s+(?:e|and)\s+|,\s*",
            values_text,
            flags=re.IGNORECASE,
        )

        for part in parts:

            value = part.strip(
                " .,!?"
            )

            if value:
                memories.append({
                    "subject": subject,
                    "predicate": predicate,
                    "object": value,
                    "salience": 0.60,
                })

        if memories:
            return memories

    return []


MEMORY_PROPOSAL_TTL_SECONDS = 60 * 60
PENDING_MEMORY_PROPOSALS: dict[str, dict] = {}
PENDING_MEMORY_PROPOSALS_LOCK = threading.Lock()


def is_memory_intent(text: str) -> bool:
    """Return whether the user explicitly asked to add something to memory."""

    normalized = re.sub(
        r"\s+",
        " ",
        str(text or "").lower(),
    ).strip()

    if normalized.startswith(
        (
            "ricorda ",
            "memorizza ",
            "remember ",
            "memorize ",
            "save this ",
        )
    ):
        return True

    return bool(
        re.search(
            r"\b(?:aggiungi|inserisci|salva|add|store)\b"
            r".*\b(?:memoria|memory|neural\s*core|core)\b",
            normalized,
        )
    )


def _memory_request_content(message: str) -> str:
    """Remove a memory command prefix while retaining the stated fact."""

    cleaned = str(message or "").strip()

    cleaned = re.sub(
        r"^(?:per favore\s*,?\s*)?"
        r"(?:ricorda|memorizza|remember|memorize|save this)"
        r"\s*(?:che\s+)?",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )

    cleaned = re.sub(
        r"^(?:per favore\s*,?\s*)?"
        r"(?:aggiungi|inserisci|salva|add|store)"
        r"(?:\s+(?:questo|this))?"
        r"(?:\s+(?:al|alla|nel|nella|to|in))?"
        r"(?:\s+(?:neural\s*core|core|memoria|memory))?"
        r"\s*(?:che\s+)?",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )

    return cleaned.strip(" .!?")


def _clean_memory_candidate(
    item: dict,
) -> dict | None:
    """Normalize a user-reviewed memory before it reaches the proposal UI."""

    account_subject = _memory_subject()
    subject = str(item.get("subject", account_subject)).strip()
    predicate = str(item.get("predicate", "remembers")).strip()
    object_value = str(item.get("object", "")).strip()

    if not object_value:
        return None

    if subject.lower() in {
        "i",
        "me",
        "my",
        "user",
        "the user",
        "operator",
        "operator's",
    }:
        subject = account_subject

    if not subject or len(subject) > 80:
        subject = account_subject

    if not predicate or len(predicate) > 80:
        predicate = "remembers"

    object_value = object_value[:240]

    try:
        salience = float(item.get("salience", 0.7))
    except (TypeError, ValueError):
        salience = 0.7

    return {
        "subject": subject,
        "predicate": predicate,
        "object": object_value,
        "salience": max(0.1, min(1.0, salience)),
    }


def extract_memory_candidates(
    message: str,
) -> list[dict]:
    """Build memory suggestions without writing anything to the database."""

    statement = _memory_request_content(message)
    subject = _memory_subject()

    if not statement:
        return []

    candidates = extract_explicit_memories(statement)

    project_match = re.search(
        r"(?:il\s+)?mio\s+progetto\s+(?:si\s+chiama|è)\s+(.+)",
        statement,
        re.IGNORECASE,
    )

    if project_match:
        candidates.append({
            "subject": subject,
            "predicate": "has_project",
            "object": project_match.group(1).strip(" .!?"),
            "salience": 0.78,
        })

    creation_match = re.search(
        r"(?:ho\s+)?(?:creato|avviato|configurato|lanciato)\s+(.+)",
        statement,
        re.IGNORECASE,
    )

    if creation_match:
        candidates.append({
            "subject": subject,
            "predicate": "has_created",
            "object": creation_match.group(1).strip(" .!?"),
            "salience": 0.82,
        })

    ownership_match = re.search(
        r"(?:ho|possiedo)\s+(.+)",
        statement,
        re.IGNORECASE,
    )

    if ownership_match and not creation_match:
        candidates.append({
            "subject": subject,
            "predicate": "owns",
            "object": ownership_match.group(1).strip(" .!?"),
            "salience": 0.68,
        })

    if not candidates:
        candidates.append({
            "subject": subject,
            "predicate": "remembers",
            "object": statement,
            "salience": 0.66,
        })

    normalized: list[dict] = []
    seen: set[tuple[str, str, str]] = set()

    for candidate in candidates:
        cleaned = _clean_memory_candidate(candidate)

        if not cleaned:
            continue

        identity = (
            cleaned["subject"].casefold(),
            cleaned["predicate"].casefold(),
            cleaned["object"].casefold(),
        )

        if identity in seen:
            continue

        seen.add(identity)
        normalized.append(cleaned)

    return normalized[:8]


def create_memory_proposal(
    message: str,
) -> dict | None:
    """Stage explicit memories until the user presses Add to Neural Core."""

    candidates = extract_memory_candidates(message)

    if not candidates:
        return None

    created_at = time.time()
    proposal_id = uuid4().hex

    with PENDING_MEMORY_PROPOSALS_LOCK:
        PENDING_MEMORY_PROPOSALS[proposal_id] = {
            "items": candidates,
            "created_at": created_at,
            "owner_id": _active_account_id(),
        }

        expired = [
            key
            for key, proposal in PENDING_MEMORY_PROPOSALS.items()
            if created_at - proposal["created_at"] > MEMORY_PROPOSAL_TTL_SECONDS
        ]

        for key in expired:
            PENDING_MEMORY_PROPOSALS.pop(key, None)

    return {
        "id": proposal_id,
        "items": candidates,
    }


def commit_memory_proposal(
    proposal_id: str,
) -> int:
    """Persist a staged proposal once its UI confirmation is pressed."""

    normalized_id = str(proposal_id or "").strip()
    with PENDING_MEMORY_PROPOSALS_LOCK:
        proposal = PENDING_MEMORY_PROPOSALS.get(normalized_id)

        if not proposal:
            raise ValueError(
                "This memory proposal has expired. Ask ULTRON to prepare it again."
            )

        if proposal.get("owner_id") != _active_account_id():
            raise ValueError("This memory proposal belongs to another local account.")

        if time.time() - proposal["created_at"] > MEMORY_PROPOSAL_TTL_SECONDS:
            PENDING_MEMORY_PROPOSALS.pop(normalized_id, None)
            raise ValueError(
                "This memory proposal has expired. Ask ULTRON to prepare it again."
            )

        # Pop while locked so two simultaneous confirmation clicks cannot
        # create duplicate memories. Persisting happens after the short lock.
        items = list(proposal["items"])
        PENDING_MEMORY_PROPOSALS.pop(normalized_id, None)

    return store_memories(
        items,
        source="user-confirmed",
    )


def extract_and_store_memory(user_message: str) -> dict | None:
    """Compatibility helper that never writes memory without UI confirmation.

    Older ULTRON builds called this name directly after a chat message. Keeping
    the public helper proposal-only protects users if an integration still uses
    that legacy entry point.
    """

    if not is_memory_intent(str(user_message or "")):
        return None

    return create_memory_proposal(str(user_message))


app = FastAPI(
    title="ULTRON Backend",
    docs_url="/docs" if ENABLE_API_DOCS else None,
    redoc_url=None,
    openapi_url="/openapi.json" if ENABLE_API_DOCS else None,
)

app.add_middleware(AuthContextMiddleware)
app.include_router(auth_router)
app.include_router(skills_router)
app.include_router(printer_router)
app.include_router(external_apps_router)


@app.on_event("shutdown")
def release_printer_connections() -> None:
    """Release only explicitly opened serial links when the local core exits."""

    close_all_printer_connections()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "ultron://app",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "X-Ultron-Launch-Secret",
    ],
)


@app.middleware("http")
async def require_desktop_launch_capability(
    request: FastAPIRequest,
    call_next,
):
    """Bind a packaged loopback service to the Electron process that started it.

    A random port avoids fixed-port collisions. The per-launch capability also
    prevents another local process from registering accounts, reading a signed
    in session, or racing the desktop shell onto its local API port.
    """

    if (
        BACKEND_LAUNCH_SECRET
        and request.url.path.startswith("/api/")
        and request.method != "OPTIONS"
    ):
        supplied = request.headers.get("x-ultron-launch-secret", "")
        if not hmac.compare_digest(supplied, BACKEND_LAUNCH_SECRET):
            return JSONResponse(
                status_code=403,
                content={"detail": "The ULTRON desktop channel was not verified."},
            )

    return await call_next(request)


@app.middleware("http")
async def require_signed_in_account(
    request: FastAPIRequest,
    call_next,
):
    """Keep every non-authentication local API endpoint account-bound.

    The service stays on loopback, but loopback alone does not separate
    applications or accounts on the same Mac. Verification is also enforced
    when SMTP verification has been enabled.
    """

    path = request.url.path
    is_public = (
        request.method == "OPTIONS"
        or path == "/api/health"
        or path.startswith("/api/auth/")
    )

    if is_public or not path.startswith("/api/"):
        return await call_next(request)

    try:
        require_verified_auth(request.headers.get("authorization"))
    except HTTPException as error:
        return JSONResponse(
            status_code=error.status_code,
            content={"detail": error.detail},
            headers=error.headers or {},
        )

    return await call_next(request)


@app.middleware("http")
async def add_api_security_headers(
    request: FastAPIRequest,
    call_next,
):
    """Prevent API responses, especially session tokens, from being cached.

    The renderer has its own strict CSP. These headers cover the loopback API
    and apply equally to normal and authentication responses.
    """

    response = await call_next(request)

    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
        response.headers.setdefault("Pragma", "no-cache")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")

    return response


previous_net = psutil.net_io_counters()
previous_time = time.monotonic()


def load_config():
    config_file = _active_profile_dir() / "config.json"
    if not config_file.exists():
        return {}

    try:
        return json.loads(config_file.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_config(config):
    config_file = _active_profile_dir() / "config.json"
    temporary_file = config_file.with_suffix(".tmp")
    temporary_file.write_text(
        json.dumps(config, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    temporary_file.replace(config_file)

    try:
        config_file.chmod(0o600)
    except OSError:
        pass


class ObsidianConfig(BaseModel):
    path: str


class ObsidianCaptureRequest(BaseModel):
    text: str = Field(min_length=1, max_length=12_000)


class EmailOpenRequest(BaseModel):
    provider: str = "mail"


class EmailComposeRequest(BaseModel):
    to: list[str] = Field(default_factory=list)
    subject: str = ""
    body: str = ""


class EmailSendRequest(BaseModel):
    to: list[str] = Field(default_factory=list)
    subject: str = ""
    body: str = ""


class MemoryCommitRequest(BaseModel):
    proposal_id: str = Field(min_length=8, max_length=128)


class LocationLookupRequest(BaseModel):
    query: str = Field(min_length=2, max_length=240)


class ModelPathRequest(BaseModel):
    path: str = Field(min_length=1, max_length=4096)


# A model has to come through the native picker before the file, Cura, or Finder
# endpoints will touch it.  This keeps the local API from becoming a general
# filesystem reader while still letting the 3D deck work with the model that the
# person explicitly selected.
# Files with ``previewable`` are parsed in the renderer.  The other common
# fabrication/CAD/slicer formats still appear in the deck with their metadata
# and can be passed to a chosen local application, but they are never blindly
# decoded by the browser as if they were a Three.js mesh.  That keeps unknown
# vendor containers useful without pretending that every format has a native
# preview implementation.
MODEL_FILE_TYPES = {
    ".stl": {"format": "STL", "media_type": "model/stl", "previewable": True},
    ".obj": {"format": "OBJ", "media_type": "text/plain", "previewable": True},
    ".3mf": {"format": "3MF", "media_type": "model/3mf", "previewable": True},
    ".amf": {"format": "AMF", "media_type": "application/amf+xml", "previewable": True},
    ".ply": {"format": "PLY", "media_type": "application/octet-stream", "previewable": True},
    ".gcode": {"format": "G-code", "media_type": "text/plain", "previewable": True},
    ".gco": {"format": "G-code", "media_type": "text/plain", "previewable": True},
    ".gc": {"format": "G-code", "media_type": "text/plain", "previewable": True},
    ".g": {"format": "G-code", "media_type": "text/plain", "previewable": True},
    ".nc": {"format": "G-code", "media_type": "text/plain", "previewable": True},
    ".tap": {"format": "G-code", "media_type": "text/plain", "previewable": True},
    ".bgcode": {"format": "Binary G-code", "media_type": "application/octet-stream", "previewable": False},
    ".step": {"format": "STEP CAD", "media_type": "application/step", "previewable": False},
    ".stp": {"format": "STEP CAD", "media_type": "application/step", "previewable": False},
    ".iges": {"format": "IGES CAD", "media_type": "application/iges", "previewable": False},
    ".igs": {"format": "IGES CAD", "media_type": "application/iges", "previewable": False},
    ".x3d": {"format": "X3D", "media_type": "model/x3d+xml", "previewable": False},
    ".wrl": {"format": "VRML", "media_type": "model/vrml", "previewable": False},
    ".dae": {"format": "COLLADA", "media_type": "model/vnd.collada+xml", "previewable": False},
    ".glb": {"format": "glTF binary", "media_type": "model/gltf-binary", "previewable": True},
    ".gltf": {"format": "glTF", "media_type": "model/gltf+json", "previewable": True},
    ".fbx": {"format": "FBX", "media_type": "application/octet-stream", "previewable": False},
    ".svg": {"format": "SVG", "media_type": "image/svg+xml", "previewable": False},
    ".dxf": {"format": "DXF", "media_type": "application/dxf", "previewable": False},
    ".scad": {"format": "OpenSCAD", "media_type": "text/plain", "previewable": False},
    ".f3d": {"format": "Fusion design", "media_type": "application/octet-stream", "previewable": False},
    ".fcstd": {"format": "FreeCAD project", "media_type": "application/octet-stream", "previewable": False},
    ".skp": {"format": "SketchUp model", "media_type": "application/octet-stream", "previewable": False},
    ".sldprt": {"format": "SolidWorks part", "media_type": "application/octet-stream", "previewable": False},
    ".dwg": {"format": "DWG drawing", "media_type": "application/octet-stream", "previewable": False},
    ".x3g": {"format": "MakerBot job", "media_type": "application/octet-stream", "previewable": False},
    ".phz": {"format": "Resin job", "media_type": "application/octet-stream", "previewable": False},
    ".bambu": {"format": "Bambu project", "media_type": "application/octet-stream", "previewable": False},
    ".project": {"format": "Slicer project", "media_type": "application/octet-stream", "previewable": False},
    ".sl1": {"format": "Resin job", "media_type": "application/octet-stream", "previewable": False},
    ".ctb": {"format": "Resin job", "media_type": "application/octet-stream", "previewable": False},
    ".photon": {"format": "Resin job", "media_type": "application/octet-stream", "previewable": False},
    ".pwmo": {"format": "Resin job", "media_type": "application/octet-stream", "previewable": False},
    ".pws": {"format": "Resin job", "media_type": "application/octet-stream", "previewable": False},
    ".zip": {"format": "Model archive", "media_type": "application/zip", "previewable": False},
}
GENERIC_EXTERNAL_MODEL_TYPE = {
    "format": "External fabrication asset",
    "media_type": "application/octet-stream",
    "previewable": False,
}
MODEL_MAX_BYTES = 512 * 1024 * 1024
MODEL_PREVIEW_MAX_BYTES = 150 * 1024 * 1024
MODEL_SELECTION_TTL_SECONDS = 6 * 60 * 60
_selected_model_paths: dict[str, dict[str, float]] = {}


def _selected_models_for_active_account() -> dict[str, float]:
    return _selected_model_paths.setdefault(_active_account_id(), {})


def _cleanup_selected_model_paths() -> None:
    """Forget stale local picker selections."""

    selections = _selected_models_for_active_account()
    cutoff = time.monotonic() - MODEL_SELECTION_TTL_SECONDS
    expired = [
        path
        for path, selected_at in selections.items()
        if selected_at < cutoff
    ]

    for path in expired:
        selections.pop(path, None)


def _model_error(status_code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail=detail)


def _resolve_model_file(
    path: str,
    *,
    require_selected: bool = True,
) -> Path:
    """Validate one regular, local model file selected by the native picker."""

    raw_path = str(path or "").strip()

    if not raw_path or "\x00" in raw_path:
        raise _model_error(400, "Select a local 3D model first.")

    requested = Path(raw_path).expanduser()

    if not requested.is_absolute():
        raise _model_error(400, "Use the model selected from the local 3D deck.")

    try:
        resolved = requested.resolve(strict=True)
        file_stat = resolved.stat()
    except (OSError, RuntimeError) as error:
        raise _model_error(404, "The selected 3D model is no longer available.") from error

    suffix = resolved.suffix.casefold()

    if not stat.S_ISREG(file_stat.st_mode):
        raise _model_error(400, "Choose a regular local model file.")

    if file_stat.st_size < 1:
        raise _model_error(400, "The selected 3D model is empty.")

    if file_stat.st_size > MODEL_MAX_BYTES:
        raise _model_error(413, "Files larger than 512 MB cannot be catalogued here.")

    canonical_path = str(resolved)

    if require_selected:
        _cleanup_selected_model_paths()

        if canonical_path not in _selected_models_for_active_account():
            raise _model_error(
                403,
                "Choose this model from the 3D deck before opening it.",
            )

    return resolved


def _remember_selected_model(model_path: Path) -> None:
    _cleanup_selected_model_paths()
    _selected_models_for_active_account()[str(model_path)] = time.monotonic()


def _require_desktop_picker(request: FastAPIRequest) -> None:
    """Accept native selections only from this Electron launch instance."""

    if not BACKEND_DESKTOP_PICKER_SECRET:
        raise _model_error(
            503,
            "The native desktop selector is unavailable in this session.",
        )

    supplied = request.headers.get("X-Ultron-Desktop-Picker", "").strip()
    if not supplied or not hmac.compare_digest(
        supplied,
        BACKEND_DESKTOP_PICKER_SECRET,
    ):
        raise _model_error(403, "The local desktop selection was not verified.")


def _read_model_prefix(model_path: Path, byte_limit: int = 512 * 1024) -> bytes:
    """Read a bounded prefix only for small, non-authoritative model telemetry."""

    try:
        with model_path.open("rb") as handle:
            return handle.read(byte_limit)
    except OSError:
        return b""


def _model_telemetry(model_path: Path, file_size: int) -> dict:
    """Return lightweight format facts without parsing or mutating the model."""

    suffix = model_path.suffix.casefold()
    prefix = _read_model_prefix(model_path)
    text = prefix.decode("utf-8", errors="ignore")
    sampled = file_size > len(prefix)
    facts: dict[str, object] = {
        "sampled": sampled,
        "sampleBytes": len(prefix),
    }

    if suffix == ".stl":
        if len(prefix) >= 84:
            triangle_count = int.from_bytes(prefix[80:84], "little")
            expected_size = 84 + (triangle_count * 50)

            if expected_size == file_size:
                facts.update({
                    "encoding": "binary",
                    "triangles": triangle_count,
                })
            else:
                facts.update({
                    "encoding": "ascii-or-unverified-binary",
                    "facetsInSample": text.casefold().count("facet normal"),
                })
        else:
            facts["encoding"] = "unknown"

    elif suffix == ".obj":
        lines = text.splitlines()
        facts.update({
            "encoding": "text",
            "verticesInSample": sum(
                1 for line in lines if line.lstrip().startswith("v ")
            ),
            "facesInSample": sum(
                1 for line in lines if line.lstrip().startswith("f ")
            ),
        })

    elif suffix == ".ply":
        header = text.split("end_header", 1)[0]
        vertex_match = re.search(r"^element\s+vertex\s+(\d+)", header, re.MULTILINE)
        face_match = re.search(r"^element\s+face\s+(\d+)", header, re.MULTILINE)
        facts.update({
            "encoding": "ascii" if "format ascii" in header.casefold() else "binary-or-unknown",
            "vertices": int(vertex_match.group(1)) if vertex_match else None,
            "faces": int(face_match.group(1)) if face_match else None,
        })

    elif suffix == ".amf":
        facts.update({
            "encoding": "xml",
            "objectsInSample": len(re.findall(r"<object(?:\s|>)", text, re.IGNORECASE)),
        })

    elif suffix == ".3mf":
        facts.update({
            "container": "3MF package",
            "zipSignature": prefix.startswith(b"PK\x03\x04"),
        })

    elif suffix in {".gcode", ".gco", ".gc", ".g", ".nc", ".tap"}:
        layer_match = re.search(r"^;LAYER_COUNT:(\d+)", text, re.MULTILINE)
        time_match = re.search(r"^;TIME:(\d+)", text, re.MULTILINE)
        facts.update({
            "encoding": "text",
            "layers": int(layer_match.group(1)) if layer_match else None,
            "estimatedSeconds": int(time_match.group(1)) if time_match else None,
        })

    return facts


def _model_metadata(model_path: Path) -> dict:
    """Return renderer-safe facts for the selected model card."""

    file_stat = model_path.stat()
    descriptor = MODEL_FILE_TYPES.get(
        model_path.suffix.casefold(),
        GENERIC_EXTERNAL_MODEL_TYPE,
    )
    modified = datetime.fromtimestamp(
        file_stat.st_mtime,
        tz=timezone.utc,
    ).astimezone().isoformat(timespec="seconds")

    return {
        "path": str(model_path),
        "name": model_path.name,
        "extension": model_path.suffix.casefold().lstrip("."),
        "ext": model_path.suffix.casefold().lstrip("."),
        "format": descriptor["format"],
        "mediaType": descriptor["media_type"] or mimetypes.guess_type(model_path.name)[0],
        "sizeBytes": file_stat.st_size,
        "size": file_stat.st_size,
        "modified": modified,
        "modifiedAt": modified,
        "modifiedUnix": int(file_stat.st_mtime),
        "selected": True,
        "preview": {
            "supported": bool(descriptor["previewable"]),
            "reason": None if descriptor["previewable"] else "Open this asset in a connected local slicer or CAD application.",
        },
        "telemetry": _model_telemetry(model_path, file_stat.st_size),
    }


def get_obsidian_path():
    config = load_config()
    path = config.get("obsidian_path", "")

    if not path:
        return None

    return Path(path).expanduser()


def get_obsidian_root() -> Path:
    """Return the configured vault root, never an arbitrary filesystem path."""

    path = get_obsidian_path()

    if path is None:
        raise HTTPException(
            status_code=409,
            detail="Connect an Obsidian vault in Settings first.",
        )

    if not path.exists() or not path.is_dir():
        raise HTTPException(
            status_code=404,
            detail="The configured Obsidian vault folder was not found.",
        )

    return path.resolve()


def _obsidian_capture_title(text: str) -> str:
    """Make a compact Markdown heading from an explicitly archived command."""

    cleaned = " ".join(str(text or "").split())
    if not cleaned:
        return "ULTRON Capture"

    creation_match = re.search(
        r"(?:ho\s+)?(?:creato|avviato|configurato|lanciato)\s+(.+)",
        cleaned,
        re.IGNORECASE,
    )

    if creation_match:
        return creation_match.group(1).strip(" .!?")[:88] or "ULTRON Capture"

    return cleaned[:88].rstrip(" .!?") or "ULTRON Capture"


def write_obsidian_capture(text: str) -> dict:
    """Archive one user-armed command in a fixed note inside the connected vault."""

    clean = str(text or "").strip()
    if not clean:
        raise HTTPException(status_code=400, detail="Missing text.")

    root = get_obsidian_root()
    archive_dir = root / "ULTRON"
    archive_file = archive_dir / "Neural Core.md"
    title = _obsidian_capture_title(clean)
    timestamp = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")

    try:
        archive_dir.mkdir(parents=True, exist_ok=True)

        if not archive_file.exists():
            archive_file.write_text(
                "---\n"
                "tags:\n"
                "  - ultron\n"
                "  - neural-core\n"
                "source: ULTRON Command Link\n"
                "---\n\n"
                "# ULTRON Neural Core\n\n"
                "User-armed entries from ULTRON's command channel.\n",
                encoding="utf-8",
            )

        with archive_file.open("a", encoding="utf-8") as handle:
            handle.write(
                f"\n## {timestamp} — {title}\n\n"
                f"{clean}\n"
            )
    except OSError as error:
        raise HTTPException(
            status_code=500,
            detail="ULTRON could not write to the connected Obsidian vault.",
        ) from error

    memories = extract_memory_candidates(f"ricorda che {clean}")
    saved = store_memories(
        memories,
        source="obsidian-confirmed",
    )

    return {
        "ok": True,
        "path": archive_file.relative_to(root).as_posix(),
        "title": title,
        "saved": saved,
    }


def _obsidian_preview(content: str) -> str:
    """Create a compact plaintext note preview for the local vault browser."""

    lines: list[str] = []
    in_frontmatter = False

    for raw_line in content.splitlines():
        line = raw_line.strip()

        if line == "---":
            in_frontmatter = not in_frontmatter
            continue

        if in_frontmatter or not line:
            continue

        line = re.sub(r"^#{1,6}\s*", "", line)
        line = re.sub(
            r"!?(?:\[([^\]]*)\]\([^)]*\)|\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\])",
            lambda match: next(
                (value for value in match.groups() if value),
                "",
            ),
            line,
        )
        line = re.sub(r"[*_`>]", "", line).strip()

        if line:
            lines.append(line)

        if len(" ".join(lines)) >= 300:
            break

    return " ".join(lines)[:300]


def _obsidian_note_metadata(
    file: Path,
    root: Path,
    content: str | None = None,
) -> dict:
    """Build metadata without exposing a path outside the configured vault."""

    resolved = file.resolve()

    try:
        relative_path = resolved.relative_to(root).as_posix()
    except ValueError as error:
        raise HTTPException(
            status_code=403,
            detail="That note is outside the connected Obsidian vault.",
        ) from error

    if content is None:
        content = resolved.read_text(
            encoding="utf-8",
            errors="ignore",
        )

    stat = resolved.stat()
    tags = re.findall(
        r"(?<![\w/])#([\w/-]+)",
        content,
    )
    links = re.findall(r"\[\[([^\]]+)\]\]", content)

    return {
        "id": relative_path,
        "name": resolved.stem,
        "path": relative_path,
        "modifiedAt": int(stat.st_mtime * 1000),
        "size": stat.st_size,
        "preview": _obsidian_preview(content),
        "tags": list(dict.fromkeys(tags))[:12],
        "linkCount": len(links),
    }


def read_optional_sensors():
    path = _active_profile_dir() / "sensors.json"

    if not path.exists():
        return {
            "gpu_percent": None,
            "temp_c": None,
        }

    try:
        data = json.loads(path.read_text())

        return {
            "gpu_percent": data.get("gpu_percent"),
            "temp_c": data.get("temp_c"),
        }

    except Exception:
        return {
            "gpu_percent": None,
            "temp_c": None,
        }



# =========================================================
# PRINTER INTEGRATIONS
# =========================================================
#
# Printer routes are supplied by printer_service.  Unlike the original
# auto-detection block, GET /api/printer/status never opens serial devices or
# scans a LAN.  A signed-in operator explicitly saves and connects a profile.


_CURA_APP_PATHS = (
    Path("/Applications/UltiMaker Cura.app"),
    Path("/Applications/Ultimaker Cura.app"),
    Path("/Applications/Cura.app"),
    Path.home() / "Applications" / "UltiMaker Cura.app",
    Path.home() / "Applications" / "Ultimaker Cura.app",
    Path.home() / "Applications" / "Cura.app",
)
_CURA_APP_NAMES = (
    "UltiMaker Cura",
    "Ultimaker Cura",
    "Cura",
)


def _windows_cura_paths() -> list[Path]:
    """Return conventional Cura executables without searching arbitrary disks."""

    roots: list[Path] = []
    for variable in ("ProgramFiles", "ProgramW6432", "LOCALAPPDATA"):
        value = os.getenv(variable, "").strip()
        if not value:
            continue
        root = Path(value)
        roots.append(root)
        # Per-user Windows installers conventionally live under
        # LocalAppData\Programs. Keep this narrow and never scan a disk.
        if variable == "LOCALAPPDATA":
            roots.append(root / "Programs")

    seen: set[Path] = set()
    candidates: list[Path] = []
    patterns = (
        "UltiMaker Cura*/UltiMaker-Cura.exe",
        "Ultimaker Cura*/Cura.exe",
        "Cura*/Cura.exe",
    )
    for root in roots:
        for pattern in patterns:
            try:
                matches = root.glob(pattern)
            except OSError:
                continue
            for candidate in matches:
                try:
                    resolved = candidate.resolve(strict=True)
                except (OSError, RuntimeError):
                    continue
                if resolved.is_file() and resolved not in seen:
                    seen.add(resolved)
                    candidates.append(resolved)
    return candidates


def _open_model_in_cura(model_path: Path) -> dict:
    """Pass the picked model to an installed local Cura application."""

    attempts: list[list[str]] = []
    system = platform.system()

    if system == "Darwin":
        for app_path in _CURA_APP_PATHS:
            if app_path.is_dir():
                attempts.append(["open", "-a", str(app_path), str(model_path)])

        for app_name in _CURA_APP_NAMES:
            attempts.append(["open", "-a", app_name, str(model_path)])
    elif system == "Windows":
        attempts.extend(
            [[str(app_path), str(model_path)] for app_path in _windows_cura_paths()]
        )
    else:
        raise _model_error(
            501,
            "Direct Cura handoff is currently available in the macOS and Windows desktop builds.",
        )

    last_error = ""

    for command in attempts:
        try:
            if system == "Windows":
                subprocess.Popen(
                    command,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                return {
                    "ok": True,
                    "application": Path(command[0]).stem,
                    "model": model_path.name,
                }

            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            last_error = str(error)
            continue

        if result.returncode == 0:
            return {
                "ok": True,
                "application": command[2],
                "model": model_path.name,
            }

        last_error = (result.stderr or result.stdout or "").strip()

    if not attempts:
        raise _model_error(
            404,
            "UltiMaker Cura was not found in the usual local application locations.",
        )

    raise _model_error(
        502,
        "ULTRON could not hand this model to UltiMaker Cura."
        + (f" {last_error[:180]}" if last_error else ""),
    )


@app.post("/api/models/pick")
def pick_local_model():
    """Open the native picker and register one local fabrication asset.

    Restricting Apple's picker to a short list made valid slicer and CAD files
    invisible. The picker now lets the operator select a regular local file;
    ULTRON marks formats it can render itself and safely hands all other
    selected assets to a user-connected local application.
    """

    if platform.system() != "Darwin":
        raise _model_error(
            501,
            "Use the ULTRON desktop file selector on this platform.",
        )

    chooser_script = """
try
    set chosenModel to choose file with prompt "Seleziona un file 3D o di stampa per ULTRON"
    return POSIX path of chosenModel
on error number -128
    return ""
end try
"""

    try:
        result = subprocess.run(
            ["osascript", "-e", chooser_script],
            capture_output=True,
            text=True,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "cancelled": True}
    except OSError as error:
        raise _model_error(
            500,
            "ULTRON could not open the macOS model chooser.",
        ) from error

    selected_path = result.stdout.strip()

    if result.returncode != 0 or not selected_path:
        return {"ok": False, "cancelled": True}

    model_path = _resolve_model_file(
        selected_path,
        require_selected=False,
    )
    _remember_selected_model(model_path)

    return {
        "ok": True,
        "file": _model_metadata(model_path),
    }


@app.post("/api/models/register")
def register_local_model(data: ModelPathRequest, request: FastAPIRequest):
    """Record one path returned by the desktop's native file dialog.

    The renderer can call this only through its per-launch loopback capability.
    It still cannot use arbitrary paths after this request: subsequent read,
    reveal, and handoff endpoints require this short-lived, account-local
    registration.
    """

    _require_desktop_picker(request)
    model_path = _resolve_model_file(data.path, require_selected=False)
    _remember_selected_model(model_path)
    return {"ok": True, "file": _model_metadata(model_path)}


@app.get("/api/models/file")
def read_selected_model(path: str):
    """Stream raw bytes only for a current model-picker selection."""

    model_path = _resolve_model_file(path)
    descriptor = MODEL_FILE_TYPES.get(
        model_path.suffix.casefold(),
        GENERIC_EXTERNAL_MODEL_TYPE,
    )

    if not descriptor["previewable"]:
        raise _model_error(
            415,
            "This asset is available in ULTRON but needs a connected local slicer or CAD application to open.",
        )

    if model_path.stat().st_size > MODEL_PREVIEW_MAX_BYTES:
        raise _model_error(
            413,
            "This asset is catalogued in ULTRON but is too large for an in-app preview. Open it in a connected local application.",
        )

    return FileResponse(
        path=model_path,
        media_type=descriptor["media_type"],
        filename=model_path.name,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.post("/api/models/open-cura")
def open_selected_model_in_cura(data: ModelPathRequest):
    """Launch Cura with one current picker selection."""

    model_path = _resolve_model_file(data.path)
    return _open_model_in_cura(model_path)


@app.post("/api/models/reveal")
def reveal_selected_model(data: ModelPathRequest):
    """Reveal the user-selected local model in the host file browser."""

    model_path = _resolve_model_file(data.path)

    system = platform.system()
    if system == "Darwin":
        command = ["open", "-R", str(model_path)]
    elif system == "Windows":
        command = ["explorer.exe", f"/select,{model_path}"]
    else:
        command = ["xdg-open", str(model_path.parent)]

    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise _model_error(
            500,
            "ULTRON could not reveal the model in the local file browser.",
        ) from error

    if result.returncode != 0:
        raise _model_error(
            502,
            "ULTRON could not reveal the model in the local file browser.",
        )

    return {"ok": True, "model": model_path.name}





# =========================================================
# ULTRON AGENT
# =========================================================

class TTSRequest(BaseModel):
    text: str
    reference_id: str | None = None


class ChatHistoryTurn(BaseModel):
    role: str = Field(min_length=1, max_length=16)
    text: str = Field(min_length=1, max_length=1600)


class AgentRequest(BaseModel):
    message: str
    history: list[ChatHistoryTurn] = Field(default_factory=list)


def open_external_url(url: str) -> None:
    """Open one explicitly requested HTTP(S) URL on the current platform."""

    parsed = urlparse(str(url or ""))
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("ULTRON can open only HTTP or HTTPS addresses.")

    if platform.system() == "Darwin":
        subprocess.Popen(
            ["open", url],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return

    if platform.system() == "Windows":
        startfile = getattr(os, "startfile", None)
        if startfile is None:
            raise OSError("The Windows URL launcher is unavailable.")
        startfile(url)
        return

    if not webbrowser.open_new_tab(url):
        raise OSError("The local URL launcher is unavailable.")


@app.post("/api/system/open-makerworld")
def open_makerworld():
    """Open MakerWorld only after an explicit command from the local UI."""

    open_external_url("https://makerworld.com/")
    return {"ok": True}


def _location_provider_lookup_url(query: str) -> str:
    """Build one safe request for a Nominatim-compatible HTTPS endpoint."""

    parsed = urlparse(LOCATION_PROVIDER_URL)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        raise HTTPException(
            status_code=503,
            detail="The local location provider configuration is invalid.",
        )

    params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    params.update(
        {
            "q": query,
            "format": "jsonv2",
            "limit": "3",
            "addressdetails": "1",
            "accept-language": "it",
        }
    )
    return urlunparse(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            parsed.params,
            urlencode(params),
            "",
        )
    )


def _cached_location_results(cache_key: str) -> list[dict[str, object]] | None:
    """Return a short-lived in-memory location lookup cache entry, if fresh."""

    now = time.monotonic()
    with _location_lookup_lock:
        cached = _location_lookup_cache.get(cache_key)
        if cached is None:
            return None

        saved_at, results = cached
        if now - saved_at > LOCATION_CACHE_TTL_SECONDS:
            _location_lookup_cache.pop(cache_key, None)
            return None

        _location_lookup_cache.move_to_end(cache_key)
        return [dict(item) for item in results]


def _reserve_location_provider_request() -> None:
    """Keep foreground location lookups inside the public provider rate limit."""

    global _location_lookup_last_request_at

    now = time.monotonic()
    with _location_lookup_lock:
        remaining = LOCATION_LOOKUP_INTERVAL_SECONDS - (
            now - _location_lookup_last_request_at
        )
        if remaining > 0:
            retry_after = max(1, int(remaining + 0.999))
            raise HTTPException(
                status_code=429,
                detail="Please wait a moment before another location search.",
                headers={"Retry-After": str(retry_after)},
            )
        _location_lookup_last_request_at = now


def _cache_location_results(
    cache_key: str,
    results: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Keep a bounded, non-persistent cache without retaining mutable values."""

    safe_results = [dict(item) for item in results]
    with _location_lookup_lock:
        _location_lookup_cache[cache_key] = (time.monotonic(), safe_results)
        _location_lookup_cache.move_to_end(cache_key)
        while len(_location_lookup_cache) > LOCATION_CACHE_LIMIT:
            _location_lookup_cache.popitem(last=False)
    return [dict(item) for item in safe_results]


def _location_lookup_response(results: list[dict[str, object]]) -> dict[str, object]:
    return {
        "ok": True,
        "results": results,
        "provider": "OpenStreetMap Nominatim",
        "attribution": "© OpenStreetMap contributors",
    }


@app.post("/api/location/resolve")
def resolve_location(request: LocationLookupRequest):
    """Resolve a location only for an explicit, foreground UI request."""

    query = " ".join(request.query.split())
    if len(query) < 2:
        raise HTTPException(
            status_code=422,
            detail="Enter at least two characters to locate a place.",
        )

    cache_key = query.casefold()
    cached_results = _cached_location_results(cache_key)
    if cached_results is not None:
        return _location_lookup_response(cached_results)

    _reserve_location_provider_request()
    lookup = Request(
        _location_provider_lookup_url(query),
        headers={
            "User-Agent": "ULTRON-local-desktop/1.1 (location lookup; github.com/Lumacaonta/Ultron)",
            "Accept": "application/json",
        },
    )

    try:
        with urlopen(lookup, timeout=8) as response:
            raw_payload = response.read(LOCATION_RESPONSE_LIMIT_BYTES + 1)
            if len(raw_payload) > LOCATION_RESPONSE_LIMIT_BYTES:
                raise ValueError("Location response exceeded the permitted size.")
            payload = json.loads(raw_payload.decode("utf-8"))
    except HTTPError:
        raise HTTPException(
            status_code=503,
            detail="The location service is temporarily unavailable.",
        )
    except (URLError, TimeoutError, OSError, ValueError):
        raise HTTPException(
            status_code=503,
            detail="The location service could not be reached.",
        )

    if not isinstance(payload, list):
        raise HTTPException(
            status_code=503,
            detail="The location service returned an invalid response.",
        )

    results = []
    for place in payload[:3]:
        if not isinstance(place, dict):
            continue

        try:
            lat = round(float(place.get("lat")), 6)
            lon = round(float(place.get("lon")), 6)
        except (TypeError, ValueError):
            continue

        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue

        label = " ".join(str(place.get("display_name", "")).split())
        if not label:
            continue

        address = place.get("address") if isinstance(place.get("address"), dict) else {}
        short_label = " ".join(
            str(
                place.get("name")
                or address.get("city")
                or address.get("town")
                or address.get("village")
                or address.get("municipality")
                or label.split(",", 1)[0]
            ).split()
        )
        kind = " ".join(
            str(
                place.get("addresstype")
                or place.get("type")
                or place.get("category")
                or "place"
            ).split()
        )

        results.append(
            {
                "label": label[:320],
                "shortLabel": short_label[:120],
                "lat": lat,
                "lon": lon,
                "kind": kind[:80],
            }
        )

    return _location_lookup_response(_cache_location_results(cache_key, results))



# =========================================================
# LOCAL EMAIL — EXPLICIT USER ACTIONS ONLY
# =========================================================

@app.get("/api/email/status")
def email_status():
    """Return Mail.app availability and account metadata.

    This endpoint does not fetch messages and is never called by a background
    task. The interface must request it directly after the user opens Email.
    """

    return get_email_status()


@app.get("/api/email/inbox")
def email_inbox(limit: int = 20):
    """Return a user-requested, read-only list of inbox message headers."""

    try:
        return list_inbox(limit)
    except EmailServiceError as error:
        raise HTTPException(
            status_code=503,
            detail=str(error),
        ) from error


@app.post("/api/email/open")
def email_open(request: EmailOpenRequest):
    """Open Mail.app or Gmail without reading or sending a message."""

    try:
        return open_email(request.provider)
    except EmailServiceError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error


@app.post("/api/email/compose")
def email_compose(request: EmailComposeRequest):
    """Open a local draft; the user alone can review and send it."""

    try:
        return compose_draft(
            request.to,
            request.subject,
            request.body,
        )
    except EmailServiceError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error


@app.post("/api/email/setup")
def email_setup():
    """Open the macOS-owned Gmail authentication flow on explicit request."""

    try:
        return open_gmail_setup()
    except EmailServiceError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error


@app.post("/api/email/send")
def email_send(request: EmailSendRequest):
    """Transmit only after the user presses SEND NOW in the local UI."""

    try:
        return send_email(
            request.to,
            request.subject,
            request.body,
        )
    except EmailServiceError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error


@app.post("/api/tts")
def text_to_speech(
    request: TTSRequest
):
    api_key = os.getenv(
        "FISH_API_KEY"
    )

    reference_id = (
        request.reference_id
        or os.getenv("FISH_VOICE_ID")
    )

    model = os.getenv(
        "FISH_MODEL",
        "s2.1-pro-free",
    )

    if not api_key:
        return {
            "enabled": False,
            "error":
                "FISH_API_KEY not configured",
        }

    if not reference_id:
        return {
            "enabled": False,
            "error":
                "FISH_VOICE_ID not configured",
        }

    payload = {
        "text": request.text,
        "reference_id": reference_id,
        "format": "mp3",
    }

    body = json.dumps(
        payload
    ).encode("utf-8")

    req = Request(
        "https://api.fish.audio/v1/tts",
        data=body,
        headers={
            "Authorization":
                f"Bearer {api_key}",
            "Content-Type":
                "application/json",
            "model":
                model,
        },
        method="POST",
    )

    try:
        with urlopen(
            req,
            timeout=30,
        ) as response:

            audio = response.read()

        return Response(
            content=audio,
            media_type="audio/mpeg",
        )

    except HTTPError as error:

        try:
            details = (
                error.read()
                .decode(
                    "utf-8",
                    errors="ignore",
                )
            )
        except Exception:
            details = str(error)

        return {
            "enabled": False,
            "status": error.code,
            "error": details,
        }

    except URLError as error:

        return {
            "enabled": False,
            "error":
                f"Fish connection error: {error}",
        }

    except Exception as error:

        return {
            "enabled": False,
            "error": str(error),
        }





@app.get("/api/tts/stream")
def tts_stream(text: str):

    clean = text.strip()

    if not clean:
        raise HTTPException(
            status_code=400,
            detail="Missing text."
        )

    api_key = os.getenv(
        "FISH_API_KEY",
        ""
    ).strip()

    reference_id = os.getenv(
        "FISH_VOICE_ID",
        ""
    ).strip()

    model = os.getenv(
        "FISH_MODEL",
        "s2.1-pro-free"
    ).strip()

    if not api_key or not reference_id:
        raise HTTPException(
            status_code=503,
            detail="Fish Audio is not configured."
        )

    payload = {
        "text": clean,
        "reference_id": reference_id,
        "format": "mp3",
    }

    request = Request(
        "https://api.fish.audio/v1/tts",
        data=json.dumps(
            payload
        ).encode("utf-8"),
        headers={
            "Authorization":
                f"Bearer {api_key}",
            "Content-Type":
                "application/json",
            "model":
                model,
        },
        method="POST",
    )

    try:
        upstream = urlopen(
            request,
            timeout=60
        )
    except HTTPError as error:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Fish Audio HTTP {error.code}"
            )
        )
    except URLError as error:
        raise HTTPException(
            status_code=502,
            detail=str(error)
        )

    def generate():

        try:
            while True:
                chunk = upstream.read(
                    16384
                )

                if not chunk:
                    break

                yield chunk

        finally:
            upstream.close()

    return StreamingResponse(
        generate(),
        media_type="audio/mpeg",
        headers={
            "Cache-Control":
                "no-store",
        },
    )


@app.get("/api/memory/graph")
def memory_graph():
    return get_memory_graph()


@app.get("/api/memory/count")
def memory_count():
    return {
        "count": get_memory_count()
    }


@app.post("/api/memory/commit")
def memory_commit(request: MemoryCommitRequest):
    """Store only a memory proposal that the user explicitly approved."""

    try:
        saved = commit_memory_proposal(request.proposal_id)
    except ValueError as error:
        raise HTTPException(
            status_code=404,
            detail=str(error),
        ) from error

    return {
        "ok": True,
        "saved": saved,
    }


def _email_skill_enabled() -> bool:
    skill = get_skill("email")
    return not skill or bool(skill.get("enabled", True))


def _is_email_read_intent(text: str) -> bool:
    return bool(
        re.search(r"\b(?:leggi|leggimi|read)\b", text)
        and re.search(r"\b(?:e-?mail|mail|posta)\b", text)
    )


def _is_email_check_intent(text: str) -> bool:
    return bool(
        re.search(r"\b(?:controlla|check|verifica|hai|ci sono|nuove)\b", text)
        and re.search(r"\b(?:e-?mail|mail|posta)\b", text)
    )


def _is_email_send_intent(text: str) -> bool:
    return bool(
        re.match(
            r"^(?:invia|manda|spedisc[ie]|send)\b",
            text,
        )
        and re.search(r"\b(?:e-?mail|mail|messaggio)\b", text)
    )


def _email_draft_from_message(message: str) -> dict | None:
    """Turn a simple spoken email instruction into a reviewable local draft."""

    recipients = re.findall(
        r"(?<![\w.@+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?![\w.@+-])",
        message,
    )

    if not recipients:
        return None

    last_recipient = recipients[-1]
    recipient_position = message.rfind(last_recipient)
    remainder = message[recipient_position + len(last_recipient):].strip(" ,:;—-")
    subject = "Messaggio da ULTRON"
    body = remainder

    subject_match = re.search(
        r"(?:^|\s)(?:oggetto|subject)\s*[:=-]?\s*([^,;]+)",
        remainder,
        flags=re.IGNORECASE,
    )

    if subject_match:
        subject = subject_match.group(1).strip(" .")[:180] or subject
        body = (
            remainder[:subject_match.start()]
            + remainder[subject_match.end():]
        ).strip(" ,:;—-")

    body = re.sub(
        r"^(?:dicendo|con\s+(?:il\s+)?messaggio|messaggio|testo|body)\s*[:=-]?\s*",
        "",
        body,
        flags=re.IGNORECASE,
    ).strip()

    if not body:
        return {
            "to": recipients,
            "subject": subject,
            "body": "",
            "needsBody": True,
        }

    return {
        "to": recipients,
        "subject": subject,
        "body": body[:10_000],
        "needsBody": False,
    }


def _unread_summary(messages: list[dict], *, include_body: bool) -> str:
    if not messages:
        return "Nessuna nuova email non letta nel tuo account Mail."

    if include_body:
        message = messages[0]
        sender = message.get("sender") or "Mittente sconosciuto"
        subject = message.get("subject") or "Senza oggetto"
        body = str(message.get("body") or "").strip()
        if len(body) > 1_000:
            body = body[:1_000].rstrip() + "…"
        return (
            f"Nuova email da {sender}. Oggetto: {subject}.\n\n"
            f"{body or 'Il messaggio non contiene testo leggibile.'}"
        )

    rows = [
        f"• {message.get('sender') or 'Mittente sconosciuto'} — "
        f"{message.get('subject') or 'Senza oggetto'}"
        for message in messages[:5]
    ]
    return (
        f"Sì: ci sono {len(messages)} email non lette.\n"
        + "\n".join(rows)
    )


@app.post("/api/agent")
def agent(request: AgentRequest):
    message = request.message.strip()

    if not message:
        return {
            "reply": "I'm listening.",
            "action": None,
        }

    text = re.sub(
        r"\s+",
        " ",
        message.lower(),
    ).strip()

    if is_memory_intent(text):
        proposal = create_memory_proposal(message)

        if not proposal:
            return {
                "reply": (
                    "Dimmi quale informazione vuoi aggiungere al Neural Core. "
                    "La preparerò per la tua conferma."
                ),
                "action": "memory_proposal_empty",
            }

        return {
            "reply": (
                "Ho isolato questo elemento per il Neural Core. "
                "Rivedilo e premi ADD TO NEURAL CORE per salvarlo."
            ),
            "action": "memory_proposal",
            "memory_proposal": proposal,
        }

    if _is_email_read_intent(text):
        if not _email_skill_enabled():
            return {
                "reply": "Email is disabled in Settings.",
                "action": "skill_disabled",
            }
        try:
            unread = get_unread_messages(
                limit=3,
                include_body=True,
            )
            return {
                "reply": _unread_summary(
                    unread["messages"],
                    include_body=True,
                ),
                "action": "email_read",
            }
        except EmailServiceError as error:
            return {
                "reply": str(error),
                "action": "email_error",
            }

    if _is_email_check_intent(text):
        if not _email_skill_enabled():
            return {
                "reply": "Email is disabled in Settings.",
                "action": "skill_disabled",
            }
        try:
            unread = get_unread_messages(limit=5)
            return {
                "reply": _unread_summary(
                    unread["messages"],
                    include_body=False,
                ),
                "action": "email_unread",
            }
        except EmailServiceError as error:
            return {
                "reply": str(error),
                "action": "email_error",
            }

    if _is_email_send_intent(text):
        if not _email_skill_enabled():
            return {
                "reply": "Email is disabled in Settings.",
                "action": "skill_disabled",
            }

        draft = _email_draft_from_message(message)

        if draft is None:
            return {
                "reply": (
                    "Dimmi l'indirizzo del destinatario, per esempio: "
                    "“invia email a nome@dominio.it dicendo …”."
                ),
                "action": "email_draft_missing_recipient",
            }

        if draft["needsBody"]:
            return {
                "reply": (
                    "Ho il destinatario, ma mi manca il testo da inviare. "
                    "Scrivimi il messaggio e preparerò la trasmissione."
                ),
                "action": "email_draft_missing_body",
            }

        return {
            "reply": (
                "Trasmissione preparata. Controlla destinatario, oggetto e "
                "contenuto, poi premi SEND NOW per inviarla."
            ),
            "action": "email_draft",
            "email_draft": draft,
        }

    skill_result = execute_skill_for_message(
        message,
        text,
        ollama_url=OLLAMA_URL,
        ollama_model=OLLAMA_MODEL,
    )

    if skill_result is not None:
        return skill_result


    # ---------------------------------------------------------
    # OPEN / LAUNCH INTENT
    # ---------------------------------------------------------

    prefixes = (
        "apri ",
        "open ",
        "lancia ",
        "launch ",
        "vai su ",
        "vai a ",
        "go to ",
    )

    target = None

    for prefix in prefixes:
        if text.startswith(prefix):
            target = text[len(prefix):].strip()
            break

    if target:
        target = target.strip(" .!?")

        for phrase in (
            "il sito di ",
            "the website of ",
        ):
            if target.startswith(phrase):
                target = target[len(phrase):].strip()
                break

        websites = {
            "youtube": (
                "https://www.youtube.com",
                "YouTube",
                "open_youtube",
            ),
            "yt": (
                "https://www.youtube.com",
                "YouTube",
                "open_youtube",
            ),
            "youtube music": (
                "https://music.youtube.com",
                "YouTube Music",
                "open_youtube_music",
            ),
            "github": (
                "https://github.com",
                "GitHub",
                "open_github",
            ),
            "chatgpt": (
                "https://chatgpt.com",
                "ChatGPT",
                "open_chatgpt",
            ),
            "google": (
                "https://www.google.com",
                "Google",
                "open_google",
            ),
            "gmail": (
                "https://mail.google.com",
                "Gmail",
                "open_gmail",
            ),
            "google drive": (
                "https://drive.google.com",
                "Google Drive",
                "open_google_drive",
            ),
            "reddit": (
                "https://www.reddit.com",
                "Reddit",
                "open_reddit",
            ),
            "discord": (
                "https://discord.com/app",
                "Discord",
                "open_discord",
            ),
        }

        if target in websites:
            url, name, action = websites[target]

            open_external_url(url)

            return {
                "reply": f"Opening {name}.",
                "action": action,
            }

        app_names = {
            "safari": "Safari",
            "finder": "Finder",
            "spotify": "Spotify",
            "terminal": "Terminal",
            "notes": "Notes",
            "calendar": "Calendar",
            "calculator": "Calculator",
            "settings": "System Settings",
            "system settings": "System Settings",
            "vs code": "Visual Studio Code",
            "vscode": "Visual Studio Code",
            "visual studio code": "Visual Studio Code",
            "code": "Visual Studio Code",
        }

        app_name = app_names.get(target, target)

        # Try opening a macOS application directly.
        result = subprocess.run(
            ["open", "-a", app_name],
            capture_output=True,
            text=True,
        )

        if result.returncode == 0:
            return {
                "reply": f"Opening {app_name}.",
                "action": f"open_app:{target}",
            }

        # Direct URL.
        if target.startswith("http://") or target.startswith("https://"):
            open_external_url(target)

            return {
                "reply": "Opening the requested website.",
                "action": "open_url",
            }

        # Domain such as example.com
        if "." in target and " " not in target:
            open_external_url(
                f"https://{target}"
            )

            return {
                "reply": "Opening the requested website.",
                "action": "open_url",
            }

    # ---------------------------------------------------------
    # LIGHTS
    # ---------------------------------------------------------

    light_words = (
        "luce",
        "luci",
        "light",
        "lights",
    )

    light_actions = (
        "accendi",
        "spegni",
        "turn on",
        "turn off",
    )

    if (
        any(word in text for word in light_words)
        and any(action in text for action in light_actions)
    ):
        return {
            "reply": "Lighting control is not connected yet.",
            "action": "lights_not_connected",
        }

    try:
        reply = ask_ollama(
            message,
            language="Italian",
            history=[
                {
                    "role": turn.role,
                    "text": turn.text,
                }
                for turn in request.history
            ],
        )

        return {
            "reply": reply,
            "action": "conversation",
        }

    except Exception as error:
        print(
            "Ollama error:",
            error,
        )

        return {
            "reply": (
                "I cannot reach my local language engine right now."
            ),
            "action": None,
        }
@app.get("/api/health")
def health():
    return {
        "status": "online",
        "instance_id": BACKEND_INSTANCE_ID or None,
    }


@app.get("/api/system")
def get_system():
    global previous_net, previous_time

    cpu = round(
        psutil.cpu_percent(interval=0.08),
        1,
    )

    memory = psutil.virtual_memory()

    disk = psutil.disk_usage("/")

    disk_total_gb = round(
        disk.total / (1024 ** 3),
        1,
    )

    disk_used_gb = round(
        disk.used / (1024 ** 3),
        1,
    )

    disk_free_gb = round(
        disk.free / (1024 ** 3),
        1,
    )

    now = time.monotonic()
    dt = max(now - previous_time, 0.1)

    current_net = psutil.net_io_counters()

    download_mbps = (
        (
            current_net.bytes_recv
            - previous_net.bytes_recv
        )
        * 8
        / dt
        / 1_000_000
    )

    upload_mbps = (
        (
            current_net.bytes_sent
            - previous_net.bytes_sent
        )
        * 8
        / dt
        / 1_000_000
    )

    previous_net = current_net
    previous_time = now

    sensors = read_optional_sensors()

    return {
        "cpu_percent": cpu,

        "ram_percent": round(
            memory.percent,
            1,
        ),

        "ram_used_gb": round(
            memory.used / (1024 ** 3),
            1,
        ),

        "ram_total_gb": round(
            memory.total / (1024 ** 3),
            1,
        ),

        "disk_percent": round(
            disk.percent,
            1,
        ),

        "disk_used_gb": disk_used_gb,
        "disk_free_gb": disk_free_gb,
        "disk_total_gb": disk_total_gb,

        "download_mbps": round(
            max(download_mbps, 0),
            2,
        ),

        "upload_mbps": round(
            max(upload_mbps, 0),
            2,
        ),

        "gpu_percent": sensors["gpu_percent"],
        "temp_c": sensors["temp_c"],

        "architecture": platform.machine(),
        # A real macOS host name can contain a person's name. The dashboard
        # needs a stable local-machine label, not an identifier that leaks
        # across ULTRON accounts sharing one installation.
        "hostname": "LOCAL HOST",

        "uptime_seconds": max(
            0,
            int(time.time() - psutil.boot_time())
        ),

        "process_count": len(
            list(psutil.process_iter())
        ),
    }


@app.get("/api/obsidian/status")
def obsidian_status():
    path = get_obsidian_path()

    if path is None:
        return {
            "connected": False,
            "path": "",
            "markdown_count": 0,
        }

    if not path.exists() or not path.is_dir():
        return {
            "connected": False,
            "path": str(path),
            "markdown_count": 0,
            "error": "Cartella non trovata",
        }

    markdown_files = list(path.rglob("*.md"))

    return {
        "connected": True,
        "path": str(path),
        "markdown_count": len(markdown_files),
    }


@app.get("/api/obsidian/files")
def obsidian_files(
    q: str = "",
    limit: int = 100,
    offset: int = 0,
):
    """Index real Markdown notes for the local Memory browser."""

    root = get_obsidian_root()
    query = str(q or "").strip().casefold()[:160]
    safe_limit = max(1, min(int(limit), 200))
    safe_offset = max(0, int(offset))
    notes: list[dict] = []

    for file in root.rglob("*.md"):
        try:
            resolved = file.resolve()
            resolved.relative_to(root)
            content = resolved.read_text(
                encoding="utf-8",
                errors="ignore",
            )
            metadata = _obsidian_note_metadata(
                resolved,
                root,
                content,
            )

            haystack = (
                f"{metadata['name']}\n{metadata['path']}\n{content}"
            ).casefold()

            if query and query not in haystack:
                continue

            notes.append(metadata)
        except (OSError, UnicodeError, ValueError, HTTPException):
            continue

    notes.sort(
        key=lambda note: note["modifiedAt"],
        reverse=True,
    )

    return {
        "ok": True,
        "query": query,
        "total": len(notes),
        "files": notes[safe_offset:safe_offset + safe_limit],
    }


@app.get("/api/obsidian/file")
def obsidian_file(path: str):
    """Read one selected Markdown file inside the configured vault only."""

    root = get_obsidian_root()
    requested = Path(str(path or ""))

    if not str(path or "").strip() or requested.is_absolute():
        raise HTTPException(
            status_code=400,
            detail="Choose a note from the connected vault.",
        )

    candidate = (root / requested).resolve()

    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise HTTPException(
            status_code=403,
            detail="That note is outside the connected Obsidian vault.",
        ) from error

    if candidate.suffix.lower() != ".md" or not candidate.is_file():
        raise HTTPException(
            status_code=404,
            detail="The selected Obsidian note was not found.",
        )

    try:
        content = candidate.read_text(
            encoding="utf-8",
            errors="ignore",
        )
        metadata = _obsidian_note_metadata(
            candidate,
            root,
            content,
        )
    except OSError as error:
        raise HTTPException(
            status_code=500,
            detail="ULTRON could not read that Obsidian note.",
        ) from error

    return {
        "ok": True,
        "file": {
            **metadata,
            "content": content[:160_000],
            "truncated": len(content) > 160_000,
        },
    }


@app.post("/api/obsidian/config")
def configure_obsidian(data: ObsidianConfig):
    path = Path(data.path).expanduser()

    if not path.exists():
        return {
            "ok": False,
            "error": "La cartella non esiste.",
        }

    if not path.is_dir():
        return {
            "ok": False,
            "error": "Il percorso non è una cartella.",
        }

    config = load_config()

    config["obsidian_path"] = str(path)

    save_config(config)

    return {
        "ok": True,
        "path": str(path),
    }


@app.post("/api/obsidian/capture")
def capture_obsidian(data: ObsidianCaptureRequest):
    """Write one deliberately armed chat command into the local vault."""

    return write_obsidian_capture(data.text)


@app.get("/api/obsidian/graph")
def obsidian_graph():
    path = get_obsidian_path()

    if path is None or not path.exists() or not path.is_dir():
        return {
            "nodes": [],
            "edges": [],
        }

    root = path.resolve()

    files = list(path.rglob("*.md"))

    nodes = {}
    edges = []

    wiki_pattern = re.compile(
        r"\[\[([^\]|#]+)"
        r"(?:#[^\]|]+)?"
        r"(?:\|[^\]]+)?\]\]"
    )

    for file in files:
        try:
            resolved = file.resolve()
            resolved.relative_to(root)
            title = resolved.stem

            content = resolved.read_text(
                encoding="utf-8",
                errors="ignore",
            )
            metadata = _obsidian_note_metadata(
                resolved,
                root,
                content,
            )

            nodes[title] = {
                "id": title,
                "name": title,
                "type": "obsidian",
                "relation": "Obsidian note",
                "source": "OBSIDIAN VAULT",
                "path": metadata["path"],
                "description": metadata["preview"],
            }

            targets = wiki_pattern.findall(content)

            for target in targets:
                target = target.strip()

                if not target:
                    continue

                edges.append(
                    {
                        "source": title,
                        "target": target,
                        "relation": "collegato",
                    }
                )

                if target not in nodes:
                    nodes[target] = {
                        "id": target,
                        "name": target,
                        "type": "obsidian",
                        "relation": "linked Obsidian note",
                        "source": "OBSIDIAN VAULT",
                    }

        except Exception:
            continue

    return {
        "nodes": list(nodes.values()),
        "edges": edges,
    }



@app.get("/api/system/choose-app")
def choose_mac_app():
    script = """
set selectedFile to choose file with prompt "Seleziona un'applicazione macOS" default location (path to applications folder)
POSIX path of selectedFile
"""

    try:
        result = subprocess.run(
            [
                "osascript",
                "-e",
                script,
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode != 0:
            return {
                "ok": False,
                "cancelled": True,
            }

        selected_path = result.stdout.strip().rstrip("/")

        if not selected_path:
            return {
                "ok": False,
                "cancelled": True,
            }

        if not selected_path.endswith(".app"):
            return {
                "ok": False,
                "error": "The selected file is not a macOS application.",
            }

        return {
            "ok": True,
            "path": selected_path,
        }

    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "cancelled": True,
        }

    except Exception as error:
        return {
            "ok": False,
            "error": str(error),
        }
