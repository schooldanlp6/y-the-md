"""Provider registry.

The `spotify` platform has two routes, and prefers whichever can actually work:

  1. `spotify` — the Web API. No extension needed and it returns ISRCs, but it
     requires Premium on the app owner.
  2. `spotify_relay` — a connected spice-ify client. Needs the extension
     running, but no dev app, no OAuth slot and no owner Premium.

`spotify` below is a facade that picks per call, so callers never have to know
which route answered.
"""
from __future__ import annotations

import logging

from . import spotify as spotify_web
from . import spotify_relay, ytm
from .base import Provider, ProviderError, build_query
from ..logic import Track

log = logging.getLogger(__name__)

PLATFORMS = ("spotify", "ytm")


class _SpotifyFacade:
    """Spotify catalogue search, unofficial-client-first (the yt-dlp model).

    Route order and rationale:

    1. **spice-ify relay (primary).** This is the yt-dlp-equivalent: it runs the
       search inside the user's real, logged-in Spotify client, hitting the same
       internal `searchModalResults` GraphQL endpoint the app's own search bar
       uses. No official API key, no owner-Premium requirement, no dev-app quota.
       Just like yt-dlp drives YouTube's internal player API rather than the
       Data API, this drives Spotify's internal client API rather than the Web
       API. This keeps YouTube Music as the sync leader (constraint 4) while
       resolving each YTM track onto Spotify.

    2. **Web API (last resort, and self-disabling).** Only worth trying when the
       app owner has Premium -- it 403s otherwise (constraint 3). Its one
       advantage is that it returns ISRCs, which the internal search does not. So
       it is tried *after* the relay, only for its metadata, and **latched off**
       the first time it returns the owner-Premium 403 so we never spam that
       error again.
    """

    name = "spotify"

    def __init__(self) -> None:
        # Set once the Web API proves permanently unusable (owner not Premium),
        # so we stop calling it and stop logging its 403 on every track.
        self._web_disabled = False

    def available(self) -> bool:
        return spotify_relay.available() or self._web_usable()

    def _web_usable(self) -> bool:
        return spotify_web.available() and not self._web_disabled

    def search(self, track: Track, limit: int = 8) -> list[Track]:
        errors: list[str] = []

        # 1. Primary: the logged-in client (yt-dlp style). No key, no Premium.
        if spotify_relay.available():
            try:
                results = spotify_relay.search(track, limit)
                if results:
                    return results
                errors.append("relay: no results")
            except ProviderError as exc:
                errors.append(f"relay: {exc}")

        # 2. Last resort: Web API, only if it has not already 403'd this session.
        if self._web_usable():
            try:
                return spotify_web.search(track, limit)
            except ProviderError as exc:
                # Owner-Premium 403 is permanent for this deployment -- disable
                # the route rather than retrying and re-logging it every track.
                if "premium" in str(exc).lower() or "403" in str(exc):
                    self._web_disabled = True
                    log.info(
                        "spotify web api disabled for the session "
                        "(owner not Premium); using the spice-ify relay only."
                    )
                errors.append(f"web-api: {exc}")

        raise ProviderError(
            "no usable Spotify route — "
            + (" | ".join(errors) if errors else "no spice-ify client connected")
        )

    def routes(self) -> dict[str, bool]:
        return {
            "spice-ify": spotify_relay.available(),
            "web-api": self._web_usable(),
        }


spotify = _SpotifyFacade()

_REGISTRY = {
    "spotify": spotify,
    "ytm": ytm,
}


def get(platform: str):
    """Return the provider for `platform`."""
    try:
        return _REGISTRY[platform]
    except KeyError:
        raise ValueError(
            f"unknown platform {platform!r}; expected one of {', '.join(PLATFORMS)}"
        ) from None


def availability() -> dict[str, bool]:
    return {name: mod.available() for name, mod in _REGISTRY.items()}


def routes() -> dict:
    """Per-platform detail, so /health can show *why* something is unavailable."""
    return {"spotify": spotify.routes(), "ytm": {"ytmusicapi": ytm.available()}}


__all__ = [
    "PLATFORMS",
    "Provider",
    "ProviderError",
    "availability",
    "build_query",
    "get",
    "routes",
    "spotify",
    "ytm",
]
