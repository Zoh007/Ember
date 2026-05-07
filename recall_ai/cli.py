from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import json
from pathlib import Path
import sys
from typing import Any

from .briefing import generate_daily_briefing, _day_bounds
from .calendar_import import import_ics
from .config import database_path
from .screen_vision import summarize_screen
from .storage import ActivityInput, RecallStore


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="recall", description="Recall local memory assistant")
    parser.add_argument("--db", default=str(database_path()), help="Path to the local SQLite database")

    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("init-db", help="Create or migrate the local database")

    capture_parser = subparsers.add_parser("capture", help="Capture an activity event from stdin JSON")
    capture_parser.add_argument("kind", choices=["window", "clipboard", "calendar", "document", "screen", "app", "app-list", "session"])

    calendar_parser = subparsers.add_parser(
        "import-calendar",
        aliases=["ingest-calendar"],
        help="Import events from a local ICS file",
    )
    calendar_parser.add_argument("ics_path", help="Path to the .ics file to import")

    briefing_parser = subparsers.add_parser("briefing", help="Generate a morning briefing")
    briefing_parser.add_argument("--date", dest="target_date", help="Briefing date in YYYY-MM-DD format")

    screen_parser = subparsers.add_parser("capture-screen", help="Summarize and capture a local screenshot")
    screen_parser.add_argument("image_path", help="Path to the screenshot image")

    query_parser = subparsers.add_parser("query-activities", help="Query activities as JSON")
    query_parser.add_argument("--date", dest="target_date", help="Query date in YYYY-MM-DD format (defaults to today)")

    args = parser.parse_args(argv)
    store = RecallStore(args.db)

    if args.command == "init-db":
        store.initialize()
        print(store.db_path)
        return 0

    if args.command == "capture":
        store.initialize()
        payload = _read_json_stdin()
        # Session capture is handled specially (start/end)
        if args.kind == "session":
            action = payload.get("action") or payload.get("metadata", {}).get("action") or "start"
            if action == "start":
                session_id = store.start_session(
                    app_name=payload.get("app_name"),
                    title=payload.get("title"),
                    metadata=payload.get("metadata"),
                    started_at=(datetime.fromisoformat(payload.get("occurred_at").replace("Z", "+00:00")) if payload.get("occurred_at") else None),
                )
                print(session_id)
                return 0
            else:
                session_id = store.end_session(
                    app_name=payload.get("app_name"),
                    title=payload.get("title"),
                    metadata=payload.get("metadata"),
                    ended_at=(datetime.fromisoformat(payload.get("occurred_at").replace("Z", "+00:00")) if payload.get("occurred_at") else None),
                )
                print(session_id or "")
                return 0

        event_id = store.record_activity(_activity_from_payload(args.kind, payload))
        print(event_id)
        return 0

    if args.command in {"import-calendar", "ingest-calendar"}:
        store.initialize()
        imported = import_ics(args.ics_path, store)
        print(imported)
        return 0

    if args.command == "briefing":
        store.initialize()
        target_date = _parse_date(args.target_date) if args.target_date else None
        print(generate_daily_briefing(store, target_date))
        return 0

    if args.command == "query-activities":
        store.initialize()
        target_date = _parse_date(args.target_date) if args.target_date else date.today()
        since, until = _day_bounds(target_date)
        activities = store.activities_between(since, until)
        sessions = store.recent_sessions(since, until)
        combined_rows: list[dict[str, Any]] = [
            {
                "id": a.id,
                "kind": a.kind,
                "occurred_at": a.occurred_at.isoformat(),
                "source": a.source,
                "app_name": a.app_name,
                "title": a.title,
                "content": a.content[:200] if a.content else "",
                "url": a.url,
                "metadata": a.metadata or {},
            }
            for a in activities
        ]
        combined_rows.extend(
            {
                "id": s["id"],
                "kind": "session",
                "occurred_at": s["started_at"].isoformat(),
                "source": "session-tracker",
                "app_name": s["app_name"],
                "title": s["title"],
                "content": "",
                "url": None,
                "metadata": {
                    "ended_at": s["ended_at"].isoformat() if s["ended_at"] else None,
                    "duration_seconds": s["duration_seconds"],
                    **(s["metadata"] or {}),
                },
            }
            for s in sessions
        )
        combined_rows.sort(key=lambda row: row["occurred_at"])
        print(json.dumps(combined_rows))
        return 0

    if args.command == "capture-screen":
        store.initialize()
        payload = _read_json_stdin()
        screen_text = payload.get("screen_text") if isinstance(payload.get("screen_text"), str) else None
        provider = payload.get("provider") if isinstance(payload.get("provider"), str) else None
        print(summarize_screen(args.image_path, store, provider=provider, ocr_text=screen_text))
        return 0

    parser.error(f"Unknown command: {args.command}")
    return 2


def _read_json_stdin() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("Capture payload must be a JSON object")
    return value


def _activity_from_payload(kind: str, payload: dict[str, Any]) -> ActivityInput:
    occurred_at = payload.get("occurred_at")
    parsed_time = (
        datetime.fromisoformat(occurred_at.replace("Z", "+00:00"))
        if isinstance(occurred_at, str)
        else datetime.now(timezone.utc)
    )
    metadata = payload.get("metadata") or {}
    if not isinstance(metadata, dict):
        metadata = {"value": metadata}

    # For app monitoring, capture window title in metadata
    if kind == "app":
        window_title = payload.get("window_title")
        if isinstance(window_title, str):
            metadata["window_title"] = window_title

    # For app-list snapshots, include the apps array in metadata
    if kind == "app-list":
        apps = payload.get("apps")
        if isinstance(apps, list):
            metadata["apps"] = apps
        # set a friendly title
        payload.setdefault("title", "Open applications snapshot")

    return ActivityInput(
        kind=kind,
        occurred_at=parsed_time,
        source=str(payload.get("source") or kind),
        app_name=str(payload.get("app_name") or ""),
        title=str(payload.get("title") or ""),
        content=str(payload.get("content") or ""),
        url=payload.get("url") if isinstance(payload.get("url"), str) else None,
        metadata=metadata,
    )


def _parse_date(value: str) -> date:
    return date.fromisoformat(value)


if __name__ == "__main__":
    raise SystemExit(main())
