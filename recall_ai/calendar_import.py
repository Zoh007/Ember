from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

from .storage import ActivityInput, RecallStore


def import_ics(path: str | Path, store: RecallStore) -> int:
    """Import local ICS events into Recall's activity timeline."""
    text = Path(path).expanduser().read_text(encoding="utf-8")
    count = 0
    for event in _parse_ics_events(text):
        event_key = event.get("UID") or f"{event.get('DTSTART')}:{event.get('SUMMARY')}"
        external_id = f"ics:{event_key}"
        before_exists = store.external_id_exists(external_id)
        store.record_activity(
            ActivityInput(
                kind="calendar",
                source="ics",
                app_name="Calendar",
                title=event.get("SUMMARY", "Calendar event"),
                content=event.get("DESCRIPTION", ""),
                url=event.get("URL"),
                metadata={
                    "location": event.get("LOCATION", ""),
                    "ends_at": event.get("DTEND", ""),
                },
                occurred_at=_parse_ics_datetime(event.get("DTSTART")),
                external_id=external_id,
            ),
        )
        if not before_exists:
            count += 1
    return count


def _parse_ics_events(text: str) -> Iterable[dict[str, str]]:
    current: dict[str, str] | None = None
    for line in _unfold_ics_lines(text):
        if line == "BEGIN:VEVENT":
            current = {}
            continue
        if line == "END:VEVENT":
            if current:
                yield current
            current = None
            continue
        if current is None or ":" not in line:
            continue

        key, value = line.split(":", 1)
        current[key.split(";", 1)[0].upper()] = _unescape_ics_value(value)


def _unfold_ics_lines(text: str) -> list[str]:
    lines: list[str] = []
    for raw_line in text.splitlines():
        if raw_line.startswith((" ", "\t")) and lines:
            lines[-1] += raw_line[1:]
        else:
            lines.append(raw_line.strip())
    return lines


def _parse_ics_datetime(value: str | None) -> datetime:
    if not value:
        return datetime.now(UTC)

    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1]
        timezone = UTC
    else:
        timezone = UTC

    for fmt in ("%Y%m%dT%H%M%S", "%Y%m%d"):
        try:
            return datetime.strptime(normalized, fmt).replace(tzinfo=timezone)
        except ValueError:
            continue
    return datetime.now(UTC)


def _unescape_ics_value(value: str) -> str:
    return (
        value.replace("\\n", "\n")
        .replace("\\N", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
    )
