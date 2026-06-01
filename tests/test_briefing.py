from __future__ import annotations

from datetime import date, datetime, timezone
from pathlib import Path
import tempfile
import unittest

from recall_ai.briefing import build_work_segments, fallback_briefing, generate_daily_briefing
from recall_ai.calendar_import import import_ics
from recall_ai.screen_vision import summarize_screen
from recall_ai.storage import Activity, RecallStore


class BriefingTests(unittest.TestCase):
    def test_build_work_segments_groups_same_window_context(self) -> None:
        activities = [
            Activity(
                id=1,
                kind="window",
                source="active-window",
                app_name="Code",
                title="recall_ai/briefing.py",
                content=None,
                url=None,
                metadata={},
                occurred_at=datetime(2026, 5, 5, 9, 0, tzinfo=timezone.utc),
            ),
            Activity(
                id=2,
                kind="window",
                source="active-window",
                app_name="Code",
                title="recall_ai/briefing.py",
                content=None,
                url=None,
                metadata={},
                occurred_at=datetime(2026, 5, 5, 9, 10, tzinfo=timezone.utc),
            ),
            Activity(
                id=3,
                kind="window",
                source="active-window",
                app_name="Slack",
                title="founders channel",
                content=None,
                url=None,
                metadata={},
                occurred_at=datetime(2026, 5, 5, 9, 12, tzinfo=timezone.utc),
            ),
        ]

        segments = build_work_segments(activities)

        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0].events, 2)
        self.assertEqual(segments[0].duration_minutes, 10)
        self.assertEqual(segments[1].app_name, "Slack")

    def test_fallback_briefing_surfaces_decisions_and_unresolved_items(self) -> None:
        activities = [
            Activity(
                id=1,
                kind="clipboard",
                source="clipboard",
                app_name=None,
                title="Clipboard update",
                content="Decision: ship local SQLite first because privacy matters",
                url=None,
                metadata={},
                occurred_at=datetime(2026, 5, 5, 14, 0, tzinfo=timezone.utc),
            ),
            Activity(
                id=2,
                kind="window",
                source="active-window",
                app_name="Docs",
                title="TODO follow up on calendar permissions",
                content=None,
                url=None,
                metadata={},
                occurred_at=datetime(2026, 5, 5, 15, 0, tzinfo=timezone.utc),
            ),
        ]

        briefing = fallback_briefing(activities, date(2026, 5, 5))

        self.assertIn("Decisions and why:", briefing)
        self.assertIn("SQLite first", briefing)
        self.assertIn("Unresolved:", briefing)
        self.assertIn("calendar permissions", briefing)

    def test_generate_daily_briefing_reads_only_target_day(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            store = RecallStore(f"{tempdir}/recall.sqlite3")
            store.initialize()
            store.record_activity(
                kind="window",
                source="active-window",
                app_name="Code",
                title="Ember v0.1",
                occurred_at=datetime(2026, 5, 5, 10, 0, tzinfo=timezone.utc),
            )
            store.record_activity(
                kind="window",
                source="active-window",
                app_name="Browser",
                title="Older unrelated work",
                occurred_at=datetime(2026, 5, 4, 10, 0, tzinfo=timezone.utc),
            )

            briefing = generate_daily_briefing(store, date(2026, 5, 5))

        self.assertIn("Ember v0.1", briefing)
        self.assertNotIn("Older unrelated work", briefing)

    def test_import_ics_records_calendar_events_once(self) -> None:
        ics = "\n".join(
            [
                "BEGIN:VCALENDAR",
                "BEGIN:VEVENT",
                "UID:event-1",
                "DTSTART:20260505T160000Z",
                "DTEND:20260505T163000Z",
                "SUMMARY:Founder sync",
                "DESCRIPTION:Decision: keep all Ember data local",
                "END:VEVENT",
                "END:VCALENDAR",
            ],
        )
        with tempfile.TemporaryDirectory() as tempdir:
            calendar_path = f"{tempdir}/calendar.ics"
            with open(calendar_path, "w", encoding="utf-8") as handle:
                handle.write(ics)
            store = RecallStore(f"{tempdir}/recall.sqlite3")

            first_count = import_ics(calendar_path, store)
            second_count = import_ics(calendar_path, store)
            briefing = generate_daily_briefing(store, date(2026, 5, 5))

        self.assertEqual(first_count, 1)
        self.assertEqual(second_count, 0)
        self.assertIn("Founder sync", briefing)

    def test_fallback_briefing_includes_screen_summaries(self) -> None:
        activities = [
            Activity(
                id=1,
                kind="screen",
                source="screen-capture",
                app_name="Screen",
                title="Screen snapshot",
                content="Screen shows Slack thread discussing onboarding blockers.",
                url=None,
                metadata={"screenshot_path": "/tmp/shot.jpg"},
                occurred_at=datetime(2026, 5, 5, 16, 0, tzinfo=timezone.utc),
            ),
        ]

        briefing = fallback_briefing(activities, date(2026, 5, 5))

        self.assertIn("screen observations", briefing)
        self.assertIn("onboarding blockers", briefing)

    def test_screen_summary_records_local_placeholder_without_vision_provider(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            image_path = Path(tempdir) / "screen.png"
            image_path.write_bytes(b"not-a-real-png")
            store = RecallStore(f"{tempdir}/recall.sqlite3")

            summary = summarize_screen(image_path, store, provider="none")
            briefing = generate_daily_briefing(store, date.today())

        self.assertIn("Screen snapshot saved locally", summary)
        self.assertIn("Screen snapshot saved locally", briefing)


if __name__ == "__main__":
    unittest.main()
