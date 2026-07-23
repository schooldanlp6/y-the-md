"""YouTube Music catalogue search.

Unauthenticated ytmusicapi is enough for public search, so the matcha needs no
YouTube cookies. YouTube Music exposes no ISRC, which is why fuzzy scoring --
not identifier lookup -- is the primary path in this direction.
"""
from __future__ import annotations

from .. import config
from ..logic import Track
from .base import ProviderError, build_query

name = "ytm"

_client = None
_init_failed = False


def _get_client():
    global _client, _init_failed

    if _client is not None:
        return _client
    if _init_failed:
        raise ProviderError("ytm provider unavailable")

    try:
        from ytmusicapi import YTMusic

        _client = YTMusic()
    except Exception as exc:  # noqa: BLE001 - surfaced as ProviderError
        _init_failed = True
        raise ProviderError(f"could not initialize ytmusic client: {exc}") from exc

    return _client


def available() -> bool:
    # No credentials required; assume reachable until a call proves otherwise.
    return True


def _duration_to_ms(value) -> int | None:
    """ytmusicapi gives duration_seconds, or a "m:ss" / "h:mm:ss" string."""
    if isinstance(value, (int, float)):
        return int(value * 1000)
    if not isinstance(value, str) or not value.strip():
        return None

    total = 0
    try:
        for part in value.split(":"):
            total = total * 60 + int(part)
    except ValueError:
        return None
    return total * 1000


def _to_track(item: dict) -> Track | None:
    video_id = item.get("videoId")
    if not video_id:
        return None

    artists = tuple(
        a["name"] for a in (item.get("artists") or []) if a.get("name")
    )
    duration = item.get("duration_seconds")
    if duration is None:
        duration = item.get("duration")

    return Track(
        id=video_id,
        title=item.get("title", ""),
        artists=artists,
        album=(item.get("album") or {}).get("name")
        if isinstance(item.get("album"), dict)
        else item.get("album"),
        duration_ms=_duration_to_ms(duration),
        isrc=None,
    )


def search(track: Track, limit: int = 8) -> list[Track]:
    client = _get_client()

    try:
        results = client.search(build_query(track), filter="songs", limit=limit)
    except Exception as exc:  # noqa: BLE001
        raise ProviderError(f"ytmusic search failed: {exc}") from exc

    tracks = [t for t in (_to_track(r) for r in results) if t is not None]
    return tracks[:limit]


# Read from config at call time rather than import time so tests can override.
def default_limit() -> int:
    return config.SEARCH_LIMIT
