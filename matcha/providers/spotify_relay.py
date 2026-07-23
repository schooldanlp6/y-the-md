"""Spotify catalogue search via a connected spice-ify client.

**This is the yt-dlp model applied to Spotify.** yt-dlp does not use YouTube's
official Data API; it drives the internal endpoints the real YouTube client
uses. We do the same for Spotify: the spice-ify extension runs inside the user's
logged-in desktop client and calls the internal `searchModalResults` GraphQL
query -- the exact search the Spotify app's own search bar uses. No official
API key, no owner-Premium requirement, no dev-app quota. That lets YouTube Music
stay the sync leader while every YTM track is resolved onto Spotify here.

matcha (Python, server-side) cannot call that internal API itself -- it needs a
logged-in client's session -- so the extension does the call and returns the
result over the relay. Same `search(track, limit) -> list[Track]` contract as
`providers/spotify.py`, so callers cannot tell which route answered.
"""
from __future__ import annotations

import logging

from .. import relay
from ..logic import Track
from .base import ProviderError, build_query

log = logging.getLogger(__name__)

name = "spotify-relay"

# How long to wait for an extension to answer. It polls once a second, so this
# allows for a poll, a network round trip to Spotify, and a reply.
TIMEOUT_SECONDS = 12.0


def available() -> bool:
    """True only if a *Spotify* client has reported in recently.

    The platform filter is load-bearing: without it any live client -- including
    a YouTube Music one -- would make this claim a Spotify route exists, and
    searches would be dispatched to a client that cannot serve them.
    """
    return bool(relay.relay.live_clients("spotify"))


def _to_track(item: dict) -> Track | None:
    track_id = item.get("id") or item.get("uri")
    if not track_id:
        return None

    artists = item.get("artists") or []
    if isinstance(artists, str):
        artists = [artists]

    return Track(
        id=str(track_id),
        title=item.get("title") or item.get("name") or "",
        artists=tuple(a for a in artists if isinstance(a, str)),
        album=item.get("album"),
        duration_ms=item.get("duration_ms"),
        isrc=item.get("isrc"),
    )


def search(track: Track, limit: int = 8) -> list[Track]:
    if not available():
        raise ProviderError(
            "no spice-ify client connected — start Spotify with the extension loaded"
        )

    # Any authenticated Spotify client can serve a search, so scope it by
    # platform rather than pinning it to one client -- pinning strands the work
    # if that particular client cannot claim it.
    request_id = relay.relay.enqueue(
        "search",
        {"query": build_query(track), "limit": limit},
        platform="spotify",
    )
    result = relay.relay.wait_for(request_id, TIMEOUT_SECONDS)

    if result is None:
        raise ProviderError(
            f"spice-ify did not answer the search within {TIMEOUT_SECONDS}s"
        )
    if result.get("ok") is False:
        raise ProviderError(f"spice-ify search failed: {result.get('error')}")

    items = result.get("tracks") or []

    # When the client parsed nothing, it ships back a `debug` block describing
    # the raw response. Surface it once here so the GraphQL shape can be fixed
    # from a normal search rather than by bursting the (rate-limited) endpoint.
    if not items and result.get("debug"):
        log.warning("spice-ify search returned no tracks; debug=%s", result["debug"])

    return [t for t in (_to_track(i) for i in items) if t is not None][:limit]
