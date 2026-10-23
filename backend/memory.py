"""Per-account persistent memory for ULTRON.

Each signed-in account receives its own SQLite database below the private
ULTRON profile directory. There is deliberately no automatic migration from
the former shared ``~/.ultron/memory.db``: data from an existing private
installation must never become visible to a newly created account.
"""

from __future__ import annotations

import hashlib
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from auth import get_current_user, get_user_data_dir


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _memory_db_path() -> Path:
    """Return the memory database for the authenticated request."""

    user = get_current_user()
    user_id = str((user or {}).get("id") or "").strip()
    if not user_id:
        raise RuntimeError(
            "An authenticated ULTRON account is required for memory access."
        )
    return get_user_data_dir(user_id) / "memory.db"


def _initialize_schema(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject TEXT NOT NULL,
            predicate TEXT NOT NULL,
            object TEXT NOT NULL,
            salience REAL NOT NULL DEFAULT 0.5,
            frequency INTEGER NOT NULL DEFAULT 1,
            source TEXT NOT NULL DEFAULT 'conversation',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(subject, predicate, object)
        )
        """
    )
    connection.commit()


def get_connection() -> sqlite3.Connection:
    memory_db = _memory_db_path()
    memory_db.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(memory_db, timeout=10)
    connection.row_factory = sqlite3.Row
    _initialize_schema(connection)
    try:
        memory_db.chmod(0o600)
    except OSError:
        pass
    return connection


def init_db() -> None:
    """Initialize the current account's memory store when it is first used."""

    connection = get_connection()
    connection.close()


def store_memories(memories, source: str = "conversation") -> int:
    if not memories:
        return 0

    connection = get_connection()
    saved = 0
    try:
        for item in memories:
            subject = str(item.get("subject", "")).strip()
            predicate = str(item.get("predicate", "")).strip()
            object_value = str(item.get("object", "")).strip()
            if not subject or not predicate or not object_value:
                continue

            try:
                salience = float(item.get("salience", 0.6))
            except (TypeError, ValueError):
                salience = 0.6

            salience = max(0.1, min(1.0, salience))
            timestamp = now()
            connection.execute(
                """
                INSERT INTO memories (
                    subject, predicate, object, salience, frequency, source,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
                ON CONFLICT(subject, predicate, object)
                DO UPDATE SET
                    frequency = MIN(memories.frequency + 1, 100),
                    salience = MIN(1.0, memories.salience + excluded.salience * 0.12),
                    updated_at = excluded.updated_at
                """,
                (
                    subject,
                    predicate,
                    object_value,
                    salience,
                    source,
                    timestamp,
                    timestamp,
                ),
            )
            saved += 1

        connection.commit()
        return saved
    finally:
        connection.close()


def get_memory_graph() -> dict:
    connection = get_connection()
    try:
        rows = connection.execute(
            """
            SELECT id, subject, predicate, object, salience, frequency, source
            FROM memories
            ORDER BY salience DESC, frequency DESC, updated_at DESC
            """
        ).fetchall()
    finally:
        connection.close()

    nodes: dict[str, dict] = {}
    edges: list[dict] = []

    def node_id(value: str) -> str:
        digest = hashlib.sha1(value.encode("utf-8")).hexdigest()[:14]
        return f"memory-{digest}"

    for row in rows:
        subject = row["subject"]
        object_value = row["object"]
        subject_id = node_id(subject)
        object_id = node_id(object_value)
        nodes[subject_id] = {
            "id": subject_id,
            "name": subject,
            "relation": "MEMORY",
            "strength": min(
                1.0,
                0.25 + row["frequency"] * 0.05 + row["salience"] * 0.55,
            ),
        }
        nodes[object_id] = {
            "id": object_id,
            "name": object_value,
            "relation": row["predicate"],
            "strength": min(1.0, 0.18 + row["salience"] * 0.45),
        }
        edges.append(
            {
                "source": subject_id,
                "target": object_id,
                "relation": row["predicate"],
                "strength": row["salience"],
            }
        )

    return {"nodes": list(nodes.values()), "edges": edges}


def get_memory_count() -> int:
    connection = get_connection()
    try:
        row = connection.execute("SELECT COUNT(*) AS count FROM memories").fetchone()
        return int(row["count"])
    finally:
        connection.close()
