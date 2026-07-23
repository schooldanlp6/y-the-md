"""Configuration, read from the environment.

Nothing here may be required at import time -- `logic.py` and the test suite
must work with no environment at all.
"""
from __future__ import annotations

import os
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def load_env_file(path: Path = ENV_FILE) -> int:
    """Load `KEY=VALUE` pairs from a .env file into os.environ.

    Deliberately tiny and dependency-free -- python-dotenv is not packaged for
    Debian and this is all we need of it.

    Real environment variables always win: a value already set in os.environ is
    never overwritten, so `SPOTIFY_CLIENT_ID=... python3 -m matcha.main` and
    systemd units both override the file as you would expect.
    """
    if not path.is_file():
        return 0

    loaded = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue

        key, sep, value = line.partition("=")
        if not sep:
            continue

        key = key.strip()
        value = value.strip()
        # Strip one matched pair of surrounding quotes, if present.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]

        if key and key not in os.environ:
            os.environ[key] = value
            loaded += 1

    return loaded


load_env_file()


def env(name: str, default: str | None = None) -> str | None:
    """Read `MATCHA_<name>`, falling back to the older `MATCHER_<name>`.

    The service was renamed from "matcher" to "matcha"; accepting both keeps
    existing `.env` files working instead of failing in a way that looks like a
    misconfiguration.
    """
    return os.environ.get(f"MATCHA_{name}", os.environ.get(f"MATCHER_{name}", default))


# --- server -----------------------------------------------------------------
HOST = env("HOST", "127.0.0.1")
PORT = int(env("PORT", "8080"))
DEBUG = (env("DEBUG", "") or "").lower() in ("1", "true", "yes")

# --- auth -------------------------------------------------------------------
# Unset (the default) means the guard is a no-op. Only needed when matcha is
# reachable from off-box; see AGENTS.md.
TOKEN = env("TOKEN") or None

# --- cache ------------------------------------------------------------------
DB_PATH = Path(env("DB") or Path(__file__).parent / "matches.db")

# Confirmed matches are permanent -- a track's identity doesn't change. Misses
# expire, because catalogs gain tracks over time.
MISS_TTL_SECONDS = int(env("MISS_TTL", str(60 * 60 * 24 * 7)))

# --- providers --------------------------------------------------------------
SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET")

# How many candidates to pull per search before scoring.
SEARCH_LIMIT = int(env("SEARCH_LIMIT", "8"))
