from __future__ import annotations

import base64
from datetime import UTC, datetime
import os
from pathlib import Path

from .storage import ActivityInput, RecallStore


VISION_MODEL = "gpt-4o-mini"


def summarize_screen(image_path: str | Path, store: RecallStore) -> str:
    """Summarize a local screenshot and record the result as a screen activity."""
    path = Path(image_path).expanduser()
    if os.environ.get("OPENAI_API_KEY"):
        try:
            summary = _vision_summary(path)
        except Exception as exc:
            summary = f"Screen snapshot saved locally, but AI vision summary failed: {exc}"
    else:
        summary = "Screen snapshot saved locally. Add an OpenAI API key in Recall settings to summarize visible screen content."
    store.record_activity(
        ActivityInput(
            kind="screen",
            source="screen-capture",
            app_name="Screen",
            title="Screen snapshot summary",
            content=summary,
            metadata={"image_path": str(path), "model": VISION_MODEL},
            occurred_at=datetime.now(UTC),
            external_id=f"screen-summary:{path.name}",
        ),
    )
    return summary


def _vision_summary(path: Path) -> str:
    try:
        from openai import OpenAI
    except ImportError as exc:  # pragma: no cover - depends on optional package
        raise RuntimeError("Install requirements.txt to enable screen vision summaries") from exc

    client = OpenAI()
    image_b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    response = client.chat.completions.create(
        model=VISION_MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    "You summarize screenshots for a private work-memory assistant. "
                    "Extract visible work context: apps, documents, tasks, decisions, "
                    "unresolved questions, and where the user appears to have left off. "
                    "Do not transcribe secrets, passwords, keys, or personal identifiers. "
                    "If the screenshot is unreadable, say so briefly."
                ),
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Summarize this screenshot in 2-5 concise bullets for a morning briefing.",
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{image_b64}"},
                    },
                ],
            },
        ],
        temperature=0.1,
    )
    return response.choices[0].message.content or "Screen captured, but no summary was returned."
