from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
import os
from typing import Any, Iterable, Protocol

from .storage import Activity, RecallStore


BRIEFING_MODEL = os.environ.get("RECALL_OPENAI_MODEL", "gpt-4o-mini")


class LLMClient(Protocol):
    def summarize(self, prompt: str) -> str:
        """Return a briefing summary for the provided prompt."""


@dataclass(frozen=True)
class WorkSegment:
    app_name: str
    title: str
    started_at: datetime
    ended_at: datetime
    events: int

    @property
    def duration_minutes(self) -> int:
        seconds = max(0, (self.ended_at - self.started_at).total_seconds())
        return max(1, round(seconds / 60))


class OpenAILLMClient:
    def __init__(self, model: str = BRIEFING_MODEL) -> None:
        self.model = model

    def summarize(self, prompt: str) -> str:
        try:
            from openai import OpenAI
        except ImportError as exc:  # pragma: no cover - depends on optional package
            raise RuntimeError("Install requirements.txt to enable OpenAI briefings") from exc

        client = OpenAI()
        response = client.chat.completions.create(
            model=self.model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You write concise morning briefings from local work telemetry. "
                        "Focus on where the user left off, decisions, unresolved items, "
                        "and what needs attention. Do not invent facts."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
        )
        return response.choices[0].message.content or ""


def generate_daily_briefing(
    store: RecallStore,
    target_date: date | None = None,
    llm_client: LLMClient | None = None,
) -> str:
    target_date = target_date or datetime.now().date()
    start, end = _day_bounds(target_date)
    activities = store.activities_between(start, end)
    if not activities:
        briefing = _empty_briefing(target_date)
        store.save_briefing(target_date.isoformat(), briefing, model="local-empty")
        return briefing

    prompt = build_briefing_prompt(activities, target_date)
    if llm_client or os.environ.get("OPENAI_API_KEY"):
        client = llm_client or OpenAILLMClient()
        try:
            briefing = client.summarize(prompt).strip()
            if briefing:
                store.save_briefing(target_date.isoformat(), briefing, model=BRIEFING_MODEL)
                return briefing
        except Exception as exc:
            briefing = f"{fallback_briefing(activities, target_date)}\n\nAI summary unavailable: {exc}"
            store.save_briefing(target_date.isoformat(), briefing, model="local-fallback")
            return briefing

    briefing = fallback_briefing(activities, target_date)
    store.save_briefing(target_date.isoformat(), briefing, model="local-fallback")
    return briefing


def build_briefing_prompt(activities: Iterable[Activity], target_date: date) -> str:
    rows = list(activities)
    segments = build_work_segments(rows)
    clipboard_notes = _clipboard_snippets(rows)
    screen_notes = _screen_summaries(rows)
    decisions = infer_decision_markers(rows)
    unresolved = infer_unresolved_markers(rows)

    segment_lines = [
        f"- {segment.started_at.strftime('%H:%M')} to {segment.ended_at.strftime('%H:%M')}: "
        f"{segment.app_name} - {segment.title} ({segment.events} events)"
        for segment in segments[:20]
    ]
    clipboard_lines = [f"- {snippet}" for snippet in clipboard_notes[:10]]
    decision_lines = [f"- {marker}" for marker in decisions[:10]]
    unresolved_lines = [f"- {marker}" for marker in unresolved[:10]]

    return "\n".join(
        [
            f"Create a morning briefing for work captured on {target_date.isoformat()}.",
            "",
            "Work timeline:",
            *segment_lines,
            "",
            "Clipboard/document snippets:",
            *(clipboard_lines or ["- None captured"]),
            "",
            "Screen observations:",
            *([f"- {note}" for note in screen_notes[:10]] or ["- None captured"]),
            "",
            "Decision-like markers:",
            *(decision_lines or ["- None detected"]),
            "",
            "Unresolved/task markers:",
            *(unresolved_lines or ["- None detected"]),
            "",
            "Use these sections: Where you left off, Decisions and why, Unresolved, Needs attention.",
        ],
    )


def fallback_briefing(activities: Iterable[Activity], target_date: date) -> str:
    rows = list(activities)
    segments = build_work_segments(rows)
    app_counts = Counter(activity.app_name for activity in rows if activity.app_name)
    screen_notes = _screen_summaries(rows)
    decisions = infer_decision_markers(rows)
    unresolved = infer_unresolved_markers(rows)

    left_off = _latest_substantive_activity(rows)
    top_apps = ", ".join(app for app, _ in app_counts.most_common(3)) or "captured apps"
    timeline = "; ".join(
        f"{segment.started_at.strftime('%H:%M')} {segment.app_name}: {segment.title}"
        for segment in segments[:5]
    )

    lines = [
        f"Recall briefing for {target_date.isoformat()}",
        "",
        "Where you left off:",
        f"- Last captured context: {_describe_activity(left_off) if left_off else 'No substantive activity captured.'}",
        f"- Main work surfaces: {top_apps}.",
    ]
    if timeline:
        lines.append(f"- Recent timeline: {timeline}.")
    if screen_notes:
        lines.append(f"- Recent screen observations: {'; '.join(screen_notes[:3])}.")

    lines.extend(
        [
            "",
            "Decisions and why:",
            *_format_markers(decisions, "No explicit decision markers were captured."),
            "",
            "Unresolved:",
            *_format_markers(unresolved, "No unresolved task markers were captured."),
            "",
            "Needs attention:",
            "- Review the unresolved items above and reopen the last captured work surface.",
        ],
    )
    return "\n".join(lines)


def build_work_segments(activities: Iterable[Activity], gap_minutes: int = 20) -> list[WorkSegment]:
    windows = [
        activity
        for activity in sorted(activities, key=lambda item: item.occurred_at)
        if activity.kind in {"window", "document", "calendar", "screen"} and activity.title
    ]
    segments: list[WorkSegment] = []
    for activity in windows:
        if not segments:
            segments.append(
                WorkSegment(
                    app_name=activity.app_name,
                    title=activity.title,
                    started_at=activity.occurred_at,
                    ended_at=activity.occurred_at,
                    events=1,
                ),
            )
            continue

        last = segments[-1]
        same_context = activity.app_name == last.app_name and activity.title == last.title
        close_enough = activity.occurred_at - last.ended_at <= timedelta(minutes=gap_minutes)
        if same_context and close_enough:
            segments[-1] = WorkSegment(
                app_name=last.app_name,
                title=last.title,
                started_at=last.started_at,
                ended_at=activity.occurred_at,
                events=last.events + 1,
            )
        else:
            segments.append(
                WorkSegment(
                    app_name=activity.app_name,
                    title=activity.title,
                    started_at=activity.occurred_at,
                    ended_at=activity.occurred_at,
                    events=1,
                ),
            )
    return segments


def infer_decision_markers(activities: Iterable[Activity]) -> list[str]:
    return _markers(
        activities,
        [
            "decided",
            "decision",
            "approved",
            "chose",
            "agreed",
            "because",
            "why:",
        ],
    )


def infer_unresolved_markers(activities: Iterable[Activity]) -> list[str]:
    return _markers(
        activities,
        [
            "todo",
            "to do",
            "follow up",
            "blocked",
            "unresolved",
            "next",
            "needs",
            "question",
            "?",
        ],
    )


def _markers(activities: Iterable[Activity], needles: list[str]) -> list[str]:
    seen: set[str] = set()
    markers: list[str] = []
    for activity in sorted(activities, key=lambda item: item.occurred_at, reverse=True):
        haystack = " ".join(
            [
                activity.title or "",
                activity.content or "",
                _metadata_text(activity.metadata),
            ],
        ).lower()
        if any(needle in haystack for needle in needles):
            marker = _describe_activity(activity)
            if marker not in seen:
                seen.add(marker)
                markers.append(marker)
    return markers


def _metadata_text(metadata: dict[str, Any]) -> str:
    values: list[str] = []
    for value in metadata.values():
        if isinstance(value, str):
            values.append(value)
        elif isinstance(value, (list, tuple)):
            values.extend(str(item) for item in value)
    return " ".join(values)


def _clipboard_snippets(activities: Iterable[Activity]) -> list[str]:
    snippets = []
    for activity in sorted(activities, key=lambda item: item.occurred_at, reverse=True):
        if activity.kind != "clipboard" or not activity.content:
            continue
        content = " ".join(activity.content.split())
        if len(content) > 180:
            content = f"{content[:177]}..."
        snippets.append(f"{activity.occurred_at.strftime('%H:%M')} {content}")
    return snippets


def _screen_summaries(activities: Iterable[Activity]) -> list[str]:
    summaries: list[str] = []
    for activity in sorted(activities, key=lambda item: item.occurred_at, reverse=True):
        if activity.kind != "screen":
            continue
        summary = (activity.content or activity.metadata.get("summary") or "").strip()
        if not summary:
            continue
        summaries.append(f"{activity.occurred_at.strftime('%H:%M')} {summary}")
    return summaries


def _latest_substantive_activity(activities: Iterable[Activity]) -> Activity | None:
    rows = sorted(activities, key=lambda item: item.occurred_at, reverse=True)
    for activity in rows:
        if activity.kind != "clipboard" or len(activity.content or "") > 5:
            return activity
    return rows[0] if rows else None


def _describe_activity(activity: Activity) -> str:
    pieces = [activity.occurred_at.strftime("%H:%M"), activity.kind]
    if activity.app_name:
        pieces.append(activity.app_name)
    if activity.kind == "clipboard" and activity.content:
        content = " ".join(activity.content.split())
        pieces.append(content[:120])
    elif activity.title:
        pieces.append(activity.title)
    elif activity.content:
        content = " ".join(activity.content.split())
        pieces.append(content[:120])
    return " - ".join(pieces)


def _format_markers(markers: list[str], empty: str) -> list[str]:
    if not markers:
        return [f"- {empty}"]
    return [f"- {marker}" for marker in markers[:5]]


def _empty_briefing(target_date: date) -> str:
    return "\n".join(
        [
            f"Recall briefing for {target_date.isoformat()}",
            "",
            "No activity was captured for this day yet. Start Recall in the background to build a local work memory.",
        ],
    )


def _day_bounds(target_date: date) -> tuple[datetime, datetime]:
    local_tz = datetime.now().astimezone().tzinfo or timezone.utc
    start_local = datetime.combine(target_date, time.min, tzinfo=local_tz)
    end_local = start_local + timedelta(days=1)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)
