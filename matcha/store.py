"""SQLite match cache.

A confirmed pairing between two platforms never changes, so caching turns the
steady state of a listening session into zero network calls. Misses are cached
too -- with a TTL, since catalogs gain tracks over time.

Connections are thread-local: the Flask dev server is threaded and sqlite3
connections cannot be shared across threads.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import asdict

from . import config
from .logic import Track

_local = threading.local()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS matches (
    source_platform TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    target_platform TEXT NOT NULL,
    target_id       TEXT,
    confidence      REAL,
    method          TEXT,
    isrc            TEXT,
    payload         TEXT,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (source_platform, source_id, target_platform)
);
CREATE INDEX IF NOT EXISTS idx_matches_isrc ON matches (isrc, target_platform);
"""


def _connect() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(config.DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.executescript(_SCHEMA)
        conn.commit()
        _local.conn = conn
    return conn


def _row_to_result(row: sqlite3.Row) -> dict:
    track = json.loads(row["payload"]) if row["payload"] else None
    return {
        "target_id": row["target_id"],
        "confidence": row["confidence"],
        "method": row["method"],
        "isrc": row["isrc"],
        "track": track,
    }


def lookup(source_platform: str, source_id: str, target_platform: str) -> dict | None:
    """Return a cached result, or None on miss/expiry."""
    row = _connect().execute(
        """SELECT * FROM matches
           WHERE source_platform = ? AND source_id = ? AND target_platform = ?""",
        (source_platform, source_id, target_platform),
    ).fetchone()

    if row is None:
        return None

    # A cached miss goes stale; a cached hit never does.
    if row["target_id"] is None:
        if time.time() - row["created_at"] > config.MISS_TTL_SECONDS:
            return None

    return _row_to_result(row)


def lookup_by_isrc(isrc: str, target_platform: str) -> dict | None:
    """Find a confirmed match for this recording, whatever platform asked first.

    ISRC is the cross-platform identity of a recording, so a pairing learned
    from one direction is reusable by the other.
    """
    if not isrc:
        return None

    row = _connect().execute(
        """SELECT * FROM matches
           WHERE isrc = ? AND target_platform = ? AND target_id IS NOT NULL
           ORDER BY confidence DESC LIMIT 1""",
        (isrc, target_platform),
    ).fetchone()

    return _row_to_result(row) if row else None


def save(
    source_platform: str,
    source_id: str,
    target_platform: str,
    track: Track | None,
    confidence: float | None,
    method: str,
    isrc: str | None = None,
) -> None:
    """Record a match, or a miss when `track` is None."""
    conn = _connect()
    conn.execute(
        """INSERT OR REPLACE INTO matches
           (source_platform, source_id, target_platform, target_id,
            confidence, method, isrc, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            source_platform,
            source_id,
            target_platform,
            track.id if track else None,
            confidence,
            method,
            isrc or (track.isrc if track else None),
            json.dumps(asdict(track)) if track else None,
            int(time.time()),
        ),
    )
    conn.commit()


def stats() -> dict:
    row = _connect().execute(
        """SELECT COUNT(*) AS total,
                  SUM(CASE WHEN target_id IS NOT NULL THEN 1 ELSE 0 END) AS hits,
                  SUM(CASE WHEN target_id IS NULL THEN 1 ELSE 0 END) AS misses
           FROM matches"""
    ).fetchone()

    return {
        "entries": row["total"] or 0,
        "matched": row["hits"] or 0,
        "unmatched": row["misses"] or 0,
        "path": str(config.DB_PATH),
    }


def clear() -> int:
    conn = _connect()
    removed = conn.execute("SELECT COUNT(*) FROM matches").fetchone()[0]
    conn.execute("DELETE FROM matches")
    conn.commit()
    return removed
