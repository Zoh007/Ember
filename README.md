# Ember

Ember is a private desktop memory assistant. It runs quietly in the
background, captures lightweight work context across apps, and stores the
timeline locally in SQLite so a morning briefing can reconstruct where you
left off without requiring manual notes.

This repository contains a v0.1 implementation:

- Electron shell that lives in the tray/menu bar.
- Active application and window-title capture with common document-app
  classification.
- Optional screen snapshots with bundled cross-platform OCR, plus optional local
  Ollama or OpenAI vision summaries.
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

Ember starts without a main window. Use the tray/menu bar item to generate a
morning briefing, capture the screen now, or open the local data folder. The
**Generate morning briefing** action writes and opens `latest-briefing.txt` in
the local data folder; the SQLite database is not meant to be opened as a text
file.

On macOS, Ember appears as a small circular icon in the menu bar near the
clock and Control Center. It does not open a dock window.

For screen reading, macOS will ask for Screen Recording permission. Grant it in
System Settings -> Privacy & Security -> Screen & System Audio Recording, then
restart Ember. Screen snapshots stay in the local data folder. Downloaded apps
include bundled OCR, so users do not need to install Ollama or pay for OpenAI to
extract visible text from the screen.

Optional: local Ollama vision can produce richer descriptions than OCR:

```bash
brew install ollama
ollama serve
ollama pull llava
```

Then choose **Capture screen now** in Ember and set `settings.json` to use
Ollama:

```json
{
  "vision_provider": "local-ocr",
  "ollama_model": "llava",
  "ollama_url": "http://127.0.0.1:11434",
  "screen_capture_enabled": true,
  "screen_capture_interval_minutes": 2
}
```

The default `"vision_provider": "local-ocr"` requires no extra installs. If you prefer
Ollama, set `"vision_provider": "ollama"`. If you prefer OpenAI, set
"vision_provider": "openai" and enter the API key through Ember's Settings UI.
Do not edit `settings.json` by hand for secrets; Ember stores the key with Electron
safeStorage instead.

## Download a packaged build

### Internal builds

Every push to `main` can build downloadable desktop archives through GitHub
Actions. These are useful for development testing, but people need repository
access to download them:

1. Open the repository's **Actions** tab.
2. Select **Build desktop app**.
3. Open the latest successful run.
4. Download the artifact for your operating system:
  - `Ember-macos`
  - `Ember-windows`
  - `Ember-linux`

The packaged app includes the Python CLI (`recall_ai`) as a bundled executable, so you
do not need a separate Python environment for normal app usage.

To build locally after installing dependencies:

```bash
npm run package
```

Packaged apps are written to `release/`.
The CI workflow creates unpacked app artifacts, which can be downloaded and run
directly from the extracted artifact folder.

### Public releases

For people outside the repository, publish a versioned GitHub Release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The **Release desktop downloads** workflow builds macOS, Windows, and Linux packages
and attaches them to the release. If the repository is public, anyone can
download those files from the Releases page.

If the repository stays private, GitHub release assets are private too. In that
case, upload the release files to a public distribution host such as a marketing
site, S3/R2 bucket, or a tool such as Gumroad/Lemon Squeezy, then link to those
files from your landing page.

## Python CLI

Initialize the local database:

```bash
python3 -m recall_ai.cli init-db
```

Note on encryption key: The local database is encrypted with a machine-derived key (derived from hardware and account identifiers). This ensures an encrypted DB cannot be opened on another machine without the same hardware/account context. If you plan to replace or migrate your machine, export your briefing history or back up the database before migrating — once a machine is replaced you may not be able to open the old encrypted database on the new device.

**Release checklist (quick):**

- Ensure `migration-gate.yml` passes on all three platforms in Actions (ubuntu/macos/windows).
- Verify packaged `dist-python` includes SQLCipher artifacts: run `npm run check:package:sqlcipher` after packaging.
- Confirm CI installs `sqlcipher3-binary` (or `sqlcipher3` fallback) for Python 3.12 in the runners.
- Tag the release only after the above gates pass.

If you need me to run any of these checks or open the Actions runs, tell me which one to start with.

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

 - macOS: `~/Library/Application Support/Ember/recall.sqlite3`
 - Windows: `%APPDATA%/Ember/recall.sqlite3`
 - Linux: `~/.local/share/Ember/recall.sqlite3`

Set `RECALL_DB_PATH` to override it.

## Optional AI summaries

If `OPENAI_API_KEY` is configured, the Python briefing layer calls OpenAI using
`gpt-4o-mini` by default. Set `RECALL_OPENAI_MODEL` to use a different model.
When no API key is present, Ember still generates a local fallback briefing.

## Test

```bash
npm test
```
