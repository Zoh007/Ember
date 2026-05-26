from __future__ import annotations

import base64
from datetime import datetime
try:
    from datetime import UTC  # type: ignore
except Exception:
    from datetime import timezone

    UTC = timezone.utc
import json
import os
from pathlib import Path
import urllib.error
import urllib.request

from .storage import ActivityInput, RecallStore


OPENAI_VISION_MODEL = "gpt-4o-mini"
LOCAL_OCR_MODEL = "tesseract.js"
OLLAMA_MODEL = os.environ.get("RECALL_OLLAMA_MODEL", "llava:7b")
OLLAMA_URL = os.environ.get("RECALL_OLLAMA_URL", "http://127.0.0.1:11434")
VISION_PROMPT = (
    "Summarize this screenshot for a private work-memory assistant in 2-5 concise bullets. "
    "Extract visible professional work context: apps, documents, tasks, decisions, unresolved "
    "questions, and where the user appears to have left off. Do not transcribe secrets, "
    "passwords, keys, or personal identifiers. If the screenshot is unreadable, say so briefly."
)


def summarize_screen(
    image_path: str | Path,
    store: RecallStore,
    provider: str | None = None,
    ocr_text: str | None = None,
) -> str:
    """Summarize a local screenshot and record the result as a screen activity."""
    path = Path(image_path).expanduser()
    provider = (provider or os.environ.get("RECALL_VISION_PROVIDER", "local-ocr")).lower()
    model = LOCAL_OCR_MODEL
    try:
        if ocr_text:
            summary = _local_ocr_summary(ocr_text)
            provider = "local-ocr"
            model = LOCAL_OCR_MODEL
        elif provider in {"none", "local", "local-ocr", "ocr", "bundled-ocr"}:
            summary = (
                "Screen snapshot saved locally. Bundled OCR did not return readable text for this capture."
            )
            model = "none"
        elif provider == "openai":
            summary = _openai_vision_summary(path)
            model = OPENAI_VISION_MODEL
        else:
            summary = _ollama_vision_summary(path)
            model = OLLAMA_MODEL
    except Exception as exc:
        if provider != "openai" and os.environ.get("OPENAI_API_KEY"):
            try:
                summary = _openai_vision_summary(path)
                model = OPENAI_VISION_MODEL
                provider = "openai"
            except Exception as fallback_exc:
                summary = _failure_summary(provider, exc, fallback_exc)
        else:
            summary = _failure_summary(provider, exc)
    store.record_activity(
        ActivityInput(
            kind="screen",
            source="screen-capture",
            app_name="Screen",
            title="Screen snapshot summary",
            content=summary,
            metadata={"image_path": str(path), "model": model, "provider": provider},
            occurred_at=datetime.now(UTC),
            external_id=f"screen-summary:{path.name}",
        ),
    )
    return summary


def _local_ocr_summary(ocr_text: str) -> str:
    cleaned = " ".join(ocr_text.split())
    if not cleaned:
        return "Screen snapshot saved locally. Bundled OCR did not find readable text."
    if len(cleaned) > 900:
        cleaned = f"{cleaned[:897]}..."
    return f"Visible screen text: {cleaned}"


def _ollama_vision_summary(path: Path) -> str:
    image_b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    payload = json.dumps(
        {
            "model": OLLAMA_MODEL,
            "prompt": VISION_PROMPT,
            "images": [image_b64],
            "stream": False,
        },
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{OLLAMA_URL.rstrip('/')}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"Ollama is not reachable at {OLLAMA_URL}. Install Ollama and run `ollama pull {OLLAMA_MODEL}`.",
        ) from exc

    summary = (data.get("response") or "").strip()
    if not summary:
        raise RuntimeError("Ollama returned an empty screen summary.")
    return summary


def _openai_vision_summary(path: Path) -> str:
    try:
        from openai import OpenAI
    except ImportError as exc:  # pragma: no cover - depends on optional package
        raise RuntimeError("Install requirements.txt to enable screen vision summaries") from exc

    client = OpenAI()
    image_b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    response = client.chat.completions.create(
        model=OPENAI_VISION_MODEL,
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
                        "text": VISION_PROMPT,
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


def _failure_summary(provider: str, exc: Exception, fallback_exc: Exception | None = None) -> str:
    if provider == "openai":
        return f"Screen snapshot saved locally, but OpenAI vision summary failed: {exc}"
    if fallback_exc:
        return (
            "Screen snapshot saved locally, but local Ollama and OpenAI summaries failed. "
            f"Ollama error: {exc}. OpenAI error: {fallback_exc}"
        )
    return (
        "Screen snapshot saved locally, but local Ollama vision is not ready. "
        f"{exc}"
    )
