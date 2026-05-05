from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Iterator

from .config import database_path


SCHEMA_VERSION = 1


@dataclass(frozen=True)
class Activity:
    id: int
    occurred_at: datetime
    kind: str
    source: str
    app_name: str | None
    title: str | None
    content: str | None
    url: str | None
    metadata: dict
    external_id: str | None = None


@dataclass(frozen=True)
class ActivityInput:
    kind: str
    source: str
    app_name: str = ""
    title: str = ""
    content: str = ""
    url: str | None = None
    metadata: dict[str, Any] | None = None
    occurred_at: datetime | None = None
    external_id: str | None = None


class RecallStore:
    def __init__(self, db_path: str | Path | None = None) -> None:
        self.db_path = Path(db_path).expanduser() if db_path else database_path()

    def initialize(self) -> None:
        init_db(self.db_path)

    def record_activity(self, activity: ActivityInput | None = None, **kwargs: Any) -> int:
        if activity is None:
            activity = ActivityInput(**kwargs)
        return record_activity(
            activity.kind,
            activity.source,
            app_name=activity.app_name,
            title=activity.title,
            content=activity.content,
            url=activity.url,
            metadata=activity.metadata,
            occurred_at=activity.occurred_at,
            external_id=activity.external_id,
            path=self.db_path,
        )

    def activities_between(self, since: datetime, until: datetime, limit: int = 1_000) -> list[Activity]:
        return recent_activities(since=since, until=until, limit=limit, path=self.db_path)

    def save_briefing(self, briefing_date: str, summary: str, *, model: str, metadata: dict | None = None) -> int:
        return save_briefing(
            briefing_date,
            summary,
            model=model,
            metadata=metadata,
            path=self.db_path,
        )

    def external_id_exists(self, external_id: str) -> bool:
        return external_id_exists(external_id, path=self.db_path)


def utc_now() -> datetime:
    return datetime.now(UTC)


def _parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _connect(path: Path | None = None) -> sqlite3.Connection:
    db_path = path or database_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


@contextmanager
def connection(path: Path | None = None) -> Iterator[sqlite3.Connection]:
    conn = _connect(path)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(path: Path | None = None) -> None:
    with connection(path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS activities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                occurred_at TEXT NOT NULL,
                kind TEXT NOT NULL,
                source TEXT NOT NULL,
                app_name TEXT,
                title TEXT,
                content TEXT,
                url TEXT,
                external_id TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}'
            )
            """
        )
        _ensure_column(conn, "activities", "external_id", "TEXT")
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_external_id
            ON activities (external_id)
            WHERE external_id IS NOT NULL
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_activities_occurred_at
            ON activities (occurred_at)
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS briefings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                briefing_date TEXT NOT NULL,
                generated_at TEXT NOT NULL,
                summary TEXT NOT NULL,
                model TEXT NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}'
            )
            """
        )
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_briefings_date
            ON briefings (briefing_date)
            """
        )
        conn.execute(
            "INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)",
            ("schema_version", str(SCHEMA_VERSION)),
        )


def record_activity(
    kind: str,
    source: str,
    *,
    app_name: str | None = None,
    title: str | None = None,
    content: str | None = None,
    url: str | None = None,
    metadata: dict | None = None,
    occurred_at: datetime | None = None,
    external_id: str | None = None,
    path: Path | None = None,
) -> int:
    init_db(path)
    timestamp = (occurred_at or utc_now()).astimezone(UTC).isoformat()
    with connection(path) as conn:
        if external_id:
            row = conn.execute(
                "SELECT id FROM activities WHERE external_id = ?",
                (external_id,),
            ).fetchone()
            if row:
                return int(row["id"])
        cursor = conn.execute(
            """
            INSERT INTO activities (
                occurred_at, kind, source, app_name, title, content, url, external_id, metadata_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                timestamp,
                kind,
                source,
                app_name,
                title,
                content,
                url,
                external_id,
                json.dumps(metadata or {}, sort_keys=True),
            ),
        )
        return int(cursor.lastrowid)


def recent_activities(
    *,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = 500,
    path: Path | None = None,
) -> list[Activity]:
    init_db(path)
    since_value = (since or (utc_now() - timedelta(days=1))).astimezone(UTC).isoformat()
    until_value = (until or utc_now()).astimezone(UTC).isoformat()
    with connection(path) as conn:
        rows = conn.execute(
            """
            SELECT id, occurred_at, kind, source, app_name, title, content, url, external_id, metadata_json
            FROM activities
            WHERE occurred_at >= ? AND occurred_at <= ?
            ORDER BY occurred_at ASC
            LIMIT ?
            """,
            (since_value, until_value, limit),
        ).fetchall()
    return [
        Activity(
            id=int(row["id"]),
            occurred_at=_parse_timestamp(row["occurred_at"]),
            kind=row["kind"],
            source=row["source"],
            app_name=row["app_name"],
            title=row["title"],
            content=row["content"],
            url=row["url"],
            metadata=json.loads(row["metadata_json"] or "{}"),
            external_id=row["external_id"],
        )
        for row in rows
    ]


def external_id_exists(external_id: str, *, path: Path | None = None) -> bool:
    init_db(path)
    with connection(path) as conn:
        row = conn.execute(
            "SELECT 1 FROM activities WHERE external_id = ? LIMIT 1",
            (external_id,),
        ).fetchone()
    return row is not None


def save_briefing(
    briefing_date: str,
    summary: str,
    *,
    model: str,
    metadata: dict | None = None,
    path: Path | None = None,
) -> int:
    init_db(path)
    with connection(path) as conn:
        cursor = conn.execute(
            """
            INSERT INTO briefings (
                briefing_date, generated_at, summary, model, metadata_json
            )
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(briefing_date) DO UPDATE SET
                generated_at = excluded.generated_at,
                summary = excluded.summary,
                model = excluded.model,
                metadata_json = excluded.metadata_json
            """,
            (
                briefing_date,
                utc_now().isoformat(),
                summary,
                model,
                json.dumps(metadata or {}, sort_keys=True),
            ),
        )
        return int(cursor.lastrowid)


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, declaration: str) -> None:
    columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")
