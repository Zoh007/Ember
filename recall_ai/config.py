"""Configuration helpers for Ember's local runtime."""

from __future__ import annotations

import os
from pathlib import Path


def data_dir() -> Path:
    """Return the directory where Ember stores local private data."""
    configured = os.environ.get("RECALL_DATA_DIR")
    if configured:
        return Path(configured).expanduser()

    if os.name == "nt":
        root = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif os.environ.get("XDG_DATA_HOME"):
        root = Path(os.environ["XDG_DATA_HOME"])
    elif os.uname().sysname == "Darwin":
        root = Path.home() / "Library" / "Application Support"
    else:
        root = Path.home() / ".local" / "share"

    return root / "Ember"


def database_path() -> Path:
    configured = os.environ.get("RECALL_DB_PATH")
    if configured:
        return Path(configured).expanduser()
    return data_dir() / "recall.sqlite3"


def default_db_path() -> Path:
    """Backward-compatible alias used by the CLI."""
    return database_path()
