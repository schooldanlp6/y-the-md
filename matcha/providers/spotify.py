"""Spotify catalogue search.

Uses the client-credentials flow: catalogue search needs no user authorization,
so the matcha never touches a user token. Playback (which does need one) lives
in the bridge.
"""
from __future__ import annotations

import logging

from .. import config
from ..logic import Track
from .base import ProviderError, build_query

log = logging.getLogger(__name__)

# spotipy logs every failed request at ERROR from its own logger. The owner-
# Premium 403 is expected and handled by the facade, which latches this route
# off after the first one -- so silence spotipy's own noise and let the facade
# report it once, at INFO.
logging.getLogger("spotipy.client").setLevel(logging.CRITICAL)

name = "spotify"

_client = None
_init_failed = False


def _get_client():
    """Lazily build the spotipy client so the app boots without credentials."""
    global _client, _init_failed

    if _client is not None:
        return _client
    if _init_failed:
        raise ProviderError("spotify provider unavailable")

    if not config.SPOTIFY_CLIENT_ID or not config.SPOTIFY_CLIENT_SECRET:
        _init_failed = True
        raise ProviderError(
            "SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set"
        )

    try:
        import spotipy
        from spotipy.oauth2 import SpotifyClientCredentials

        _client = spotipy.Spotify(
            auth_manager=SpotifyClientCredentials(
                client_id=config.SPOTIFY_CLIENT_ID,
                client_secret=config.SPOTIFY_CLIENT_SECRET,
            ),
            requests_timeout=10,
        )
    except Exception as exc:  # noqa: BLE001 - surfaced as ProviderError
        _init_failed = True
        raise ProviderError(f"could not initialize spotify client: {exc}") from exc

    return _client


def available() -> bool:
    return bool(config.SPOTIFY_CLIENT_ID and config.SPOTIFY_CLIENT_SECRET)


def _to_track(item: dict) -> Track:
    return Track(
        id=item["id"],
        title=item.get("name", ""),
        artists=tuple(a["name"] for a in item.get("artists", [])),
        album=(item.get("album") or {}).get("name"),
        duration_ms=item.get("duration_ms"),
        isrc=(item.get("external_ids") or {}).get("isrc"),
    )


def search(track: Track, limit: int = 8) -> list[Track]:
    """Search Spotify, preferring an exact ISRC hit when the source has one.

    Spotify is the only side of this bridge that indexes ISRC, so when the
    source track carries one we get an exact answer for free.
    """
    client = _get_client()

    if track.isrc:
        try:
            found = client.search(q=f"isrc:{track.isrc}", type="track", limit=limit)
            items = (found.get("tracks") or {}).get("items") or []
            if items:
                return [_to_track(i) for i in items]
        except Exception as exc:  # noqa: BLE001 - fall through to text search
            log.warning("spotify isrc search failed for %s: %s", track.isrc, exc)

    try:
        found = client.search(q=build_query(track), type="track", limit=limit)
    except Exception as exc:  # noqa: BLE001
        raise ProviderError(f"spotify search failed: {exc}") from exc

    items = (found.get("tracks") or {}).get("items") or []
    return [_to_track(i) for i in items]
