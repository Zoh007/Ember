# Recall

Recall is a private desktop memory assistant. It runs quietly in the
background, captures lightweight work context across apps, and stores the
timeline locally in SQLite so a morning briefing can reconstruct where you
left off without requiring manual notes.

This repository contains a v0.1 implementation:

- Electron shell that lives in the tray/menu bar.
- Active application and window-title capture with common document-app
  classification.
- Clipboard capture with de-duplication.
- Calendar event import from local `.ics` files.
- Local SQLite storage under the user's application data directory.
- Python briefing layer that can run fully locally with deterministic fallback
  summaries.
- Optional OpenAI-powered morning briefing when `OPENAI_API_KEY` is present.

## Requirements

- Node.js and npm
- Python 3.11+

## Setup

```bash
npm install
python3 -m pip install -r requirements.txt
```

## Run the desktop app

```bash
npm start
```

Recall starts without a main window. Use the tray/menu bar item to generate a
morning briefing or open the local data folder.

## Python CLI

Initialize the local database:

```bash
python3 -m recall_ai.cli init-db
```

Capture an event from JSON on stdin:

```bash
echo '{"app_name":"Slack","title":"#product","content":"Decision: ship v0.1 because local capture works"}' \
  | python3 -m recall_ai.cli capture document
```

Import calendar events from a local ICS file:

```bash
python3 -m recall_ai.cli ingest-calendar ~/calendar.ics
```

Generate today's briefing:

```bash
python3 -m recall_ai.cli briefing
```

The default database path is platform-specific:

- macOS: `~/Library/Application Support/Recall/recall.sqlite3`
- Windows: `%APPDATA%/Recall/recall.sqlite3`
- Linux: `~/.local/share/Recall/recall.sqlite3`

Set `RECALL_DB_PATH` to override it.

## Optional AI summaries

If `OPENAI_API_KEY` is configured, the Python briefing layer calls OpenAI using
`gpt-4o-mini` by default. Set `RECALL_OPENAI_MODEL` to use a different model.
When no API key is present, Recall still generates a local fallback briefing.

## Test

```bash
npm test
```
