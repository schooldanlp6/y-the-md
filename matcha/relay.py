"""Logic / domain layer for the spice-ify rendezvous.

A Spicetify extension runs inside the Spotify client and cannot listen on a
port -- it can only make outbound HTTP calls. So the extension *polls* here for
work and posts results back, and matcha holds the state in between.

Why this exists at all: the Spotify Web API is unusable without Premium on the
app owner (see AGENTS.md constraint 3). The Spicetify client is already
authenticated as a real user, so proxying searches through it sidesteps the
whole quota regime.

Pure domain: no Flask, no HTTP. In-memory only -- this is live session state,
worthless after a restart, so persisting it would be misleading.
"""
from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field, asdict

# A client that has not polled in this long is considered gone.
CLIENT_TIMEOUT_SECONDS = 30

# Requests older than this are abandoned rather than left to accumulate.
REQUEST_TTL_SECONDS = 30

# A confirmed queue add of the same track within this window is a duplicate --
# typically several listeners in one Spotify Jam all seeing the same queued
# track and each forwarding it.
QUEUE_ADD_DEDUPE_SECONDS = 60


@dataclass
class PlaybackState:
    """What one client last reported about its local player."""

    platform: str = "spotify"
    capabilities: tuple[str, ...] = ()
    track_id: str | None = None
    title: str | None = None
    artists: tuple[str, ...] = ()
    album: str | None = None
    duration_ms: int | None = None
    position_ms: int | None = None
    paused: bool = True
    updated_at: float = field(default_factory=time.time)

    @property
    def stale(self) -> bool:
        return time.time() - self.updated_at > CLIENT_TIMEOUT_SECONDS


@dataclass
class Request:
    """Work handed to a spice-ify client: a search, or a playback command."""

    id: str
    kind: str  # 'search' | 'command'
    payload: dict
    #: Which platform may serve this. A Spotify search must never reach a
    #: YouTube Music client, and vice versa.
    platform: str | None = None
    #: Optional specific client. Advisory: see take_pending for why a request is
    #: not stranded when the named client cannot claim it.
    target: str | None = None
    #: Unclaimed work for the same target and key is replaced, not stacked.
    collapse_key: str | None = None
    created_at: float = field(default_factory=time.time)

    @property
    def expired(self) -> bool:
        return time.time() - self.created_at > REQUEST_TTL_SECONDS


class Relay:
    """Rendezvous between matcha and one or more spice-ify clients.

    Thread-safe: Flask's dev server is threaded, and the extension polls on a
    different request than whoever enqueued the work.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: dict[str, PlaybackState] = {}
        self._pending: dict[str, Request] = {}
        self._results: dict[str, dict] = {}
        self._events: dict[str, threading.Event] = {}
        #: track key -> [lock, number of callers holding or waiting on it]
        self._queue_add_locks: dict[str, list] = {}
        #: track key -> (confirmed_at, result) for recent successful queue adds
        self._queue_adds: dict[str, tuple[float, dict]] = {}

    # --- client state -----------------------------------------------------

    def report_state(self, client_id: str, state: PlaybackState) -> None:
        with self._lock:
            self._state[client_id] = state

    def get_state(self, client_id: str) -> PlaybackState | None:
        with self._lock:
            return self._state.get(client_id)

    def live_states(self) -> dict[str, PlaybackState]:
        """Every client that has reported recently, keyed by client id."""
        with self._lock:
            return {cid: s for cid, s in self._state.items() if not s.stale}

    def states(self) -> dict[str, dict]:
        with self._lock:
            return {
                cid: asdict(s) | {"stale": s.stale}
                for cid, s in self._state.items()
            }

    def live_clients(self, platform: str | None = None) -> list[str]:
        with self._lock:
            return [
                cid
                for cid, s in self._state.items()
                if not s.stale and (platform is None or s.platform == platform)
            ]

    # --- work dispatch ----------------------------------------------------

    def enqueue(
        self,
        kind: str,
        payload: dict,
        target: str | None = None,
        platform: str | None = None,
        collapse_key: str | None = None,
    ) -> str:
        """Add work for a client to pick up. Returns the request id.

        `platform` is the real constraint -- it decides who *may* serve the work.
        `target` is a preference for a specific client, used by commands that
        must reach one particular player.

        `collapse_key` makes this supersede unclaimed work for the same target
        with the same key, keeping its place in line. The engine re-decides
        every second; while a client is busy (a queue insert can take seconds)
        those decisions would otherwise stack up and all run back to back, each
        playTrack inserting yet another copy of the track.
        """
        with self._lock:
            if collapse_key is not None:
                for queued in self._pending.values():
                    if queued.target == target and queued.collapse_key == collapse_key:
                        queued.payload = payload
                        queued.created_at = time.time()
                        return queued.id

            request = Request(
                id=str(uuid.uuid4()),
                kind=kind,
                payload=payload,
                platform=platform,
                target=target,
                collapse_key=collapse_key,
            )
            self._pending[request.id] = request
            self._events[request.id] = threading.Event()
        return request.id

    def take_pending(
        self,
        limit: int = 10,
        client_id: str | None = None,
        platform: str | None = None,
    ) -> list[dict]:
        """Claim pending work. Claimed items are removed, so one client gets each.

        Platform is a hard filter; target is only a preference. A request is
        claimable when the caller is the named target, when no target was named,
        when the target has gone away, or when the caller did not identify itself
        at all -- an unidentified client is still a valid worker for its
        platform, and stranding work on an unmatched target surfaces as an
        unexplained timeout rather than an error.
        """
        with self._lock:
            self._drop_expired_locked()
            live = {cid for cid, st in self._state.items() if not st.stale}
            taken = [
                r
                for r in self._pending.values()
                if (r.platform is None or platform is None or r.platform == platform)
                and (
                    r.target is None
                    or client_id is None
                    or r.target == client_id
                    or r.target not in live
                )
            ][:limit]
            for r in taken:
                del self._pending[r.id]
            return [{"id": r.id, "kind": r.kind, "payload": r.payload} for r in taken]

    def complete(self, request_id: str, result: dict) -> bool:
        """Record a result and wake anyone waiting on it."""
        with self._lock:
            event = self._events.get(request_id)
            if event is None:
                return False
            self._results[request_id] = result
            event.set()
            return True

    def wait_for(self, request_id: str, timeout: float) -> dict | None:
        """Block until a client answers, or the timeout expires."""
        with self._lock:
            event = self._events.get(request_id)
        if event is None:
            return None

        if not event.wait(timeout):
            with self._lock:
                self._pending.pop(request_id, None)
                self._events.pop(request_id, None)
            return None

        with self._lock:
            self._events.pop(request_id, None)
            return self._results.pop(request_id, None)

    # --- queue-add de-duplication -------------------------------------------

    @contextmanager
    def queue_add_guard(self, key: str) -> Iterator[None]:
        """Serialises adds of one track, so a duplicate sees the first's result.

        Reference-counted: the lock is dropped only once nobody holds or waits
        on it. Pruning merely-unlocked locks instead would race a caller that
        has fetched the lock but not yet acquired it, giving one track two locks.
        """
        with self._lock:
            entry = self._queue_add_locks.setdefault(key, [threading.Lock(), 0])
            entry[1] += 1
        try:
            with entry[0]:
                yield
        finally:
            with self._lock:
                entry[1] -= 1
                if entry[1] == 0 and self._queue_add_locks.get(key) is entry:
                    del self._queue_add_locks[key]

    def recent_queue_add(self, key: str) -> dict | None:
        """The result of a confirmed add of this track inside the dedupe window."""
        with self._lock:
            now = time.time()
            for k in [k for k, (at, _) in self._queue_adds.items() if now - at > QUEUE_ADD_DEDUPE_SECONDS]:
                del self._queue_adds[k]
            entry = self._queue_adds.get(key)
            return entry[1] if entry else None

    def remember_queue_add(self, key: str, result: dict) -> None:
        with self._lock:
            self._queue_adds[key] = (time.time(), result)

    def _drop_expired_locked(self) -> None:
        for rid in [r.id for r in self._pending.values() if r.expired]:
            self._pending.pop(rid, None)
            event = self._events.pop(rid, None)
            if event:
                event.set()

    def stats(self) -> dict:
        with self._lock:
            return {
                "clients": len(self._state),
                "live_clients": len([s for s in self._state.values() if not s.stale]),
                "pending": len(self._pending),
                "awaiting_result": len(self._events),
            }


# One relay per process; the state is inherently global to the service.
relay = Relay()
