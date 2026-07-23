"""Provider interface.

A provider knows how to search one platform's catalogue and return candidate
`Track`s. It does no scoring -- that belongs to `logic.py`.
"""
from __future__ import annotations

from typing import Protocol

from ..logic import Track


class ProviderError(RuntimeError):
    """Provider is unusable (missing credentials, upstream failure)."""


class Provider(Protocol):
    name: str

    def search(self, track: Track, limit: int) -> list[Track]:
        """Candidate tracks for `track`, best-effort, ordered by platform relevance."""

    def available(self) -> bool:
        """True if this provider can serve requests right now."""


def build_query(track: Track) -> str:
    """Free-text query shared by both platforms."""
    parts = [track.title]
    if track.artists:
        parts.append(track.artists[0])
    return " ".join(p for p in parts if p).strip()
