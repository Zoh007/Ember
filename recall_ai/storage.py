from __future__ import annotations

import json
import getpass
import hashlib
import os
import platform
import shutil
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
try:
    # Python 3.11+ exposes datetime.UTC
    from datetime import UTC  # type: ignore
except Exception:
    from datetime import timezone

    UTC = timezone.utc
import subprocess
from pathlib import Path
from typing import Any, Iterator


def _get_sqlcipher_module():
    try:
        import sqlcipher3 as sqlcipher  # type: ignore

        return sqlcipher
    except ModuleNotFoundError as exc:  # pragma: no cover - dependency is validated in packaging
        raise RuntimeError(
            "SQLCipher support is required. Install the 'sqlcipher3-binary' dependency to open the local database."
        ) from exc

from .config import database_path


SCHEMA_VERSION = 1
CLIPBOARD_RETENTION_HOURS = 24


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
    is_work: bool | None = None


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
    is_work: bool | None = None


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
            is_work=activity.is_work,
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

    def start_session(self, *args, **kwargs) -> int:
        return start_session(*args, path=self.db_path, **kwargs)

    def end_session(self, *args, **kwargs):
        return end_session(*args, path=self.db_path, **kwargs)

    def recent_sessions(self, *args, **kwargs):
        return recent_sessions(*args, path=self.db_path, **kwargs)

    def delete_all_data(self) -> None:
        delete_all_data(path=self.db_path)


def utc_now() -> datetime:
    return datetime.now(UTC)


def _parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _derive_database_key() -> str:
    components = [platform.node(), platform.machine(), getpass.getuser()]
    if platform.system() == "Darwin":
        try:
            machine_id = subprocess.run(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                capture_output=True,
                text=True,
                check=False,
            ).stdout
            if machine_id:
                components.append(machine_id)
        except Exception:
            pass
    raw = "|".join([*components, "ember-v1"])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _is_plaintext_sqlite(path: Path) -> bool:
    try:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            conn.execute("SELECT name FROM sqlite_master LIMIT 1").fetchone()
    except sqlite3.DatabaseError:
        return False
    return True


def _migrate_plaintext_database(path: Path) -> None:
    backup_path = path.with_suffix(f"{path.suffix}.plaintext-backup")
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as plain_conn:
        plaintext_dump = "\n".join(plain_conn.iterdump())

    if not plaintext_dump.strip():
        return

    def _safe_unlink(p: Path) -> None:
        try:
            p.unlink()
        except Exception:
            try:
                p.unlink(missing_ok=True)
            except Exception:
                pass

    def _safe_move(src: Path, dst: Path, retries: int = 5) -> None:
        # On Windows, files can be transiently locked by other processes — retry a few times
        import time

        for attempt in range(retries):
            try:
                shutil.move(src, dst)
                return
            except PermissionError:
                time.sleep(0.1 * (attempt + 1))
        # Fallback: copy then try to remove original
        shutil.copy2(src, dst)
        try:
            src.unlink()
        except Exception:
            # best-effort; if we cannot unlink, leave original in place
            pass

    if backup_path.exists():
        _safe_unlink(backup_path)
    _safe_move(path, backup_path)

    try:
        encrypted_conn = _connect(path, allow_migration=False)
        try:
            encrypted_conn.executescript(plaintext_dump)
            encrypted_conn.commit()
        finally:
            encrypted_conn.close()
    except Exception:
        # Attempt to restore the original backup; try replace, then fallback to copy
        try:
            if path.exists():
                try:
                    path.unlink()
                except Exception:
                    pass
            # try atomic replace first
            try:
                backup_path.replace(path)
            except Exception:
                try:
                    shutil.copy2(backup_path, path)
                except Exception:
                    pass
        finally:
            raise
    else:
        _safe_unlink(backup_path)


def _sqlcipher_database_ready(conn: sqlite3.Connection) -> bool:
    try:
        row = conn.execute(
            "SELECT value FROM schema_meta WHERE key = 'schema_version' LIMIT 1",
        ).fetchone()
        if row is not None:
            return True
    except Exception:
        pass
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS __ember_probe (id INTEGER PRIMARY KEY)")
        conn.execute("DROP TABLE IF EXISTS __ember_probe")
        return True
    except Exception:
        return False


def _quarantine_database_file(path: Path) -> Path:
    timestamp = utc_now().strftime("%Y%m%dT%H%M%SZ")
    backup_path = path.with_name(f"{path.name}.unreadable-{timestamp}")
    if backup_path.exists():
        backup_path.unlink()
    shutil.move(path, backup_path)
    return backup_path


def _prepare_existing_database_file(db_path: Path, *, allow_migration: bool) -> Path | None:
    if not db_path.exists() or db_path.stat().st_size == 0:
        return None

    if allow_migration and _is_plaintext_sqlite(db_path):
        _migrate_plaintext_database(db_path)
        return None

    sqlcipher = _get_sqlcipher_module()
    probe = sqlcipher.connect(str(db_path))
    try:
        probe.execute(f"PRAGMA key = '{_derive_database_key()}'")
        if _sqlcipher_database_ready(probe):
            return None
    except Exception:
        pass
    finally:
        probe.close()

    return _quarantine_database_file(db_path)


def repair_database(path: Path | None = None) -> Path | None:
    db_path = path or database_path()
    backup_path = None
    if db_path.exists() and db_path.stat().st_size > 0:
        if _is_plaintext_sqlite(db_path):
            _migrate_plaintext_database(db_path)
        else:
            backup_path = _quarantine_database_file(db_path)
    init_db(db_path)
    return backup_path


def _connect(path: Path | None = None, *, allow_migration: bool = True) -> sqlite3.Connection:
    db_path = path or database_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    quarantined = _prepare_existing_database_file(db_path, allow_migration=allow_migration)
    if quarantined is not None:
        import sys

        print(
            f"Warning: moved unreadable database to {quarantined}. A new encrypted database will be created.",
            file=sys.stderr,
        )
    sqlcipher = _get_sqlcipher_module()
    connection = sqlcipher.connect(str(db_path))
    connection.execute(f"PRAGMA key = '{_derive_database_key()}'")
    # Defer schema probing until the caller actually uses the database.
    # Windows CI has shown transient failures when probing a just-created
    # SQLCipher database before any schema exists.

    # sqlcipher3 returns its own DB-API cursor/row objects; provide a
    # lightweight row factory that maps column names to values so existing
    # code can access row['colname'] as before.
    def _row_factory(cursor, row):
        return {desc[0]: row[idx] for idx, desc in enumerate(cursor.description or [])}

    connection.row_factory = _row_factory
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
        try:
            existing = conn.execute(
                "SELECT value FROM schema_meta WHERE key = 'schema_version' LIMIT 1",
            ).fetchone()
        except Exception:
            existing = None
        if existing is not None:
            cleanup_clipboard_history(conn)
            return

        schema_statements = [
            "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS activities (id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, app_name TEXT, title TEXT, content TEXT, url TEXT, external_id TEXT, is_work INTEGER, metadata_json TEXT NOT NULL DEFAULT '{}')",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_external_id ON activities (external_id) WHERE external_id IS NOT NULL",
            "CREATE INDEX IF NOT EXISTS idx_activities_occurred_at ON activities (occurred_at)",
            "CREATE TABLE IF NOT EXISTS briefings (id INTEGER PRIMARY KEY AUTOINCREMENT, briefing_date TEXT NOT NULL, generated_at TEXT NOT NULL, summary TEXT NOT NULL, model TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}')",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_briefings_date ON briefings (briefing_date)",
            "CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, app_name TEXT, title TEXT, started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER, metadata_json TEXT NOT NULL DEFAULT '{}')",
            "CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions (started_at)",
        ]

        for statement in schema_statements:
            conn.execute(statement)

        # Ensure optional columns exist for older schema compatibility
        _ensure_column(conn, "activities", "external_id", "TEXT")
        _ensure_column(conn, "activities", "is_work", "INTEGER")

        conn.execute(
            "INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)",
            ("schema_version", str(SCHEMA_VERSION)),
        )

        cleanup_clipboard_history(conn)


def delete_all_data(path: Path | None = None) -> None:
    db_path = path or database_path()
    data_dir = db_path.parent

    if data_dir.exists():
        for child in data_dir.iterdir():
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink(missing_ok=True)

    data_dir.mkdir(parents=True, exist_ok=True)
    init_db(db_path)


def cleanup_clipboard_history(conn: sqlite3.Connection, *, retention_hours: int = CLIPBOARD_RETENTION_HOURS) -> int:
    cutoff = (utc_now() - timedelta(hours=retention_hours)).astimezone(UTC).isoformat()
    cursor = conn.execute(
        "DELETE FROM activities WHERE kind = 'clipboard' AND occurred_at < ?",
        (cutoff,),
    )
    return int(cursor.rowcount or 0)


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
    is_work: bool | None = None,
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
                occurred_at, kind, source, app_name, title, content, url, external_id, is_work, metadata_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                is_work,
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
            SELECT id, occurred_at, kind, source, app_name, title, content, url, external_id, is_work, metadata_json
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
            is_work=bool(row["is_work"]) if row["is_work"] is not None else None,
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


def existing_external_ids(*, path: Path | None = None) -> set[str]:
    with connection(path) as conn:
        rows = conn.execute(
            "SELECT external_id FROM activities WHERE external_id IS NOT NULL",
        ).fetchall()
    return {str(row["external_id"]) for row in rows if row.get("external_id")}


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
    # Basic validation of table name to avoid SQL injection into PRAGMA
    import re

    if not re.match(r"^\w+$", table):
        raise ValueError("invalid table name")

    cursor = conn.execute(f"PRAGMA table_info({table})")
    existing = set()
    for row in cursor.fetchall():
        # Our row factory maps column names to dict-like rows
        if isinstance(row, dict):
            name = row.get("name")
        else:
            # fallback to tuple-based rows
            name = row[1] if len(row) > 1 else None
        if name:
            existing.add(name)

    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")


def start_session(app_name: str | None = None, title: str | None = None, *, metadata: dict | None = None, started_at: datetime | None = None, path: Path | None = None) -> int:
    init_db(path)
    timestamp = (started_at or utc_now()).astimezone(UTC).isoformat()
    with connection(path) as conn:
        cursor = conn.execute(
            "INSERT INTO sessions (app_name, title, started_at, metadata_json) VALUES (?, ?, ?, ?)",
            (app_name, title, timestamp, json.dumps(metadata or {}, sort_keys=True)),
        )
        return int(cursor.lastrowid)


def end_session(session_id: int | None = None, *, app_name: str | None = None, title: str | None = None, ended_at: datetime | None = None, metadata: dict | None = None, path: Path | None = None) -> int | None:
    init_db(path)
    timestamp = (ended_at or utc_now()).astimezone(UTC).isoformat()
    with connection(path) as conn:
        if session_id is not None:
            row = conn.execute("SELECT id, started_at FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if not row:
                return None
            started = _parse_timestamp(row["started_at"])
            ended = _parse_timestamp(timestamp)
            duration = int((ended - started).total_seconds())
            conn.execute(
                "UPDATE sessions SET ended_at = ?, duration_seconds = ?, metadata_json = ? WHERE id = ?",
                (timestamp, duration, json.dumps(metadata or {}, sort_keys=True), session_id),
            )
            return session_id

        # Find most recent open session for the app/title
        row = conn.execute(
            "SELECT id, started_at FROM sessions WHERE app_name = ? AND title = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
            (app_name, title),
        ).fetchone()
        if not row:
            return None
        started = _parse_timestamp(row["started_at"])
        ended = _parse_timestamp(timestamp)
        duration = int((ended - started).total_seconds())
        conn.execute(
            "UPDATE sessions SET ended_at = ?, duration_seconds = ?, metadata_json = ? WHERE id = ?",
            (timestamp, duration, json.dumps(metadata or {}, sort_keys=True), int(row["id"])),
        )
        return int(row["id"])


def recent_sessions(since: datetime, until: datetime, limit: int = 100, path: Path | None = None) -> list[dict]:
    init_db(path)
    since_value = since.astimezone(UTC).isoformat()
    until_value = until.astimezone(UTC).isoformat()
    with connection(path) as conn:
        rows = conn.execute(
            "SELECT id, started_at, ended_at, app_name, title, duration_seconds, metadata_json FROM sessions WHERE started_at >= ? AND started_at <= ? ORDER BY started_at DESC LIMIT ?",
            (since_value, until_value, limit),
        ).fetchall()
        result = []
        for r in rows:
            result.append(
                {
                    "id": int(r["id"]),
                    "started_at": _parse_timestamp(r["started_at"]),
                    "ended_at": _parse_timestamp(r["ended_at"]) if r["ended_at"] else None,
                    "app_name": r["app_name"],
                    "title": r["title"],
                    "duration_seconds": r["duration_seconds"],
                    "metadata": json.loads(r["metadata_json"] or "{}"),
                }
            )
        return result

