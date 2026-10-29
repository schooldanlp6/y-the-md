"""Sync engine runner.

Ties the pure decision logic in `engine.py` to live relay state: read what every
client reports, resolve the leader's track onto each follower's platform, and
enqueue whatever actions come back.

Kept separate from `engine.py` so the decision logic stays pure and testable --
everything impure (clock, relay, matching, threads) lives here.
"""
from __future__ import annotations

import logging
import os
import threading
import time

from . import engine, relay, service
from .engine import ClientState, SyncConfig

log = logging.getLogger(__name__)

TICK_SECONDS = 1.0

#: Exponential backoff for failed matches. Without this the per-tick retry rate
#: is enough to get rate-limited by the upstream platform.
FAILURE_BACKOFF_START = 15.0
FAILURE_BACKOFF_MAX = 300.0

#: A playTrack is not re-sent to a client for the same track within this window.
#: Landing one takes the client a few seconds (insert, wait for it, skip), and
#: the engine re-decides every second -- unchecked, each repeat inserted another
#: copy of the track and restarted it.
TRACK_COMMAND_COOLDOWN_SECONDS = 10.0

#: Which unclaimed commands supersede each other (see Relay.enqueue). Play and
#: pause share a slot: only the latest of the two matters.
COLLAPSE_KEYS = {
    "play": "transport",
    "pause": "transport",
    "seek": "seek",
    "playTrack": "playTrack",
}

#: What each platform can be told to do. Clients may narrow this by reporting
#: their own capabilities; they can never widen it.
PLATFORM_CAPABILITIES = {
    "ytm": frozenset({"seek", "transport", "queue"}),
    "spotify": frozenset({"seek", "transport", "queue"}),
}


def _sync_config() -> SyncConfig:
    return SyncConfig(
        crossfade_ms=int(os.environ.get("SYNC_CROSSFADE_MS", "0")),
        drift_tolerance_ms=int(
            os.environ.get("SYNC_DRIFT_TOLERANCE_MS", engine.DRIFT_TOLERANCE_MS)
        ),
    )


def _to_client_state(client_id: str, state: relay.PlaybackState) -> ClientState:
    declared = frozenset(state.capabilities or ())
    platform_caps = PLATFORM_CAPABILITIES.get(state.platform, frozenset())
    return ClientState(
        client_id=client_id,
        platform=state.platform,
        track_id=state.track_id,
        title=state.title,
        duration_ms=state.duration_ms,
        position_ms=state.position_ms,
        paused=state.paused,
        # Intersect: a client cannot claim more than its platform supports.
        capabilities=(declared & platform_caps) if declared else platform_caps,
        updated_at=state.updated_at,
    )


class SyncEngineRunner:
    """Ticks the engine against live relay state."""

    def __init__(self, leader_platform: str | None = None) -> None:
        self.leader_platform = leader_platform or os.environ.get(
            "SYNC_LEADER", "ytm"
        )
        self.echo = engine.EchoGuard()
        # Enabled by default; disable only with SYNC=0 (or SYNC_ENABLED=0).
        raw = os.environ.get("SYNC", os.environ.get("SYNC_ENABLED", "1")).strip().lower()
        self.enabled = raw not in ("0", "false", "no", "off", "")
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.last_actions: list[dict] = []
        self.last_error: str | None = None
        self._mapping_cache: dict[tuple[str, str], str | None] = {}
        #: key -> (failed_at, current_backoff_seconds)
        self._failures: dict[tuple[str, str], tuple[float, float]] = {}
        #: client_id -> (paused, changed_at). `changed_at` only advances on a
        #: real user action, not on an echo of a command we sent, so the most
        #: recently *user*-changed client is the play/pause authority.
        self._pause: dict[str, tuple[bool, float]] = {}
        #: The client currently leading. Kept until it goes stale -- see
        #: `_pick_leader`.
        self._leader_id: str | None = None
        #: (leader track id, when we first saw it) -- see `_ready_followers`.
        self._leader_track: tuple[str | None, float] = (None, 0.0)
        #: client_id -> (track value, sent_at) of the last playTrack sent.
        self._track_commands: dict[str, tuple[object, float]] = {}

    # --- mapping ----------------------------------------------------------

    def _map_track(self, leader: ClientState, target_platform: str) -> str | None:
        """Resolve the leader's track onto `target_platform`, memoised.

        Memoised on top of matcha's own cache because this runs every second and
        the answer only changes when the leader changes track.

        **Failures must back off.** This is called once per tick, so a failing
        match with no backoff becomes ~60 upstream searches a minute for as long
        as that track plays. That is exactly how we got HTTP 429 out of Spotify:
        the retry storm rate-limited the client, which then made every match
        fail, which kept the storm going.
        """
        if not leader.track_id:
            return None

        # A follower on the leader's own platform plays the very same id. This
        # is not a match at all -- and matcha rejects same-platform matches, so
        # sending it there would fail, back off, and never sync that follower.
        if target_platform == leader.platform:
            return leader.track_id

        key = (leader.track_id, target_platform)
        if key in self._mapping_cache:
            return self._mapping_cache[key]

        # Still inside the backoff window for a previous failure.
        failed_at, delay = self._failures.get(key, (0.0, 0.0))
        if failed_at and time.time() - failed_at < delay:
            return None

        state = relay.relay.get_state(leader.client_id)
        if state is None or not state.title:
            return None

        try:
            result = service.match(
                {
                    "source": leader.platform,
                    "target": target_platform,
                    "track": {
                        "id": leader.track_id,
                        "title": state.title,
                        "artists": list(state.artists),
                        "album": state.album,
                        "duration_ms": state.duration_ms,
                    },
                }
            )
            target_id = result.get("target_id") if result.get("matched") else None
        except Exception as exc:  # noqa: BLE001 - a failed match must not kill the loop
            next_delay = min(
                max(delay * 2, FAILURE_BACKOFF_START), FAILURE_BACKOFF_MAX
            )
            self._failures[key] = (time.time(), next_delay)
            log.info(
                "match failed for %s (%s); backing off %.0fs",
                leader.track_id,
                exc,
                next_delay,
            )
            return None

        # A definite "not on the other platform" is a real answer worth caching,
        # so it is stored as None rather than retried.
        self._failures.pop(key, None)
        self._mapping_cache[key] = target_id
        if len(self._mapping_cache) > 500:
            self._mapping_cache.clear()
        return target_id

    # --- transport authority ---------------------------------------------

    def _transport_authority(
        self, clients: list[ClientState], now: float
    ) -> str | None:
        """Which client most recently changed play/pause by a real user action.

        A change caused by our own command is an echo: we still record the new
        state, but we do not advance `changed_at`, so mirroring a pause does not
        make the mirrored client the new authority (which would ping-pong).
        """
        for c in clients:
            prev = self._pause.get(c.client_id)
            if prev is None:
                self._pause[c.client_id] = (c.paused, now)
                continue
            prev_paused, changed_at = prev
            if c.paused != prev_paused:
                kind = "pause" if c.paused else "play"
                echo = self.echo.is_echo(c.client_id, kind, None, now)
                self._pause[c.client_id] = (c.paused, changed_at if echo else now)

        # Forget clients that have gone away.
        live_ids = {c.client_id for c in clients}
        for cid in [k for k in self._pause if k not in live_ids]:
            del self._pause[cid]

        if not self._pause:
            return None
        return max(self._pause.items(), key=lambda kv: kv[1][1])[0]

    # --- leadership -------------------------------------------------------

    def _pick_leader(self, clients: list[ClientState]) -> ClientState | None:
        """The leading client among `clients`, or None if none can lead.

        **Sticky.** Every client reports at ~1 Hz, so "most recently updated"
        alone would hand leadership back and forth between two clients on the
        leader platform every tick, each flip dragging every follower to the
        other one's track. The current leader keeps the role for as long as it
        stays live; only then does the freshest candidate take over.
        """
        candidates = [c for c in clients if c.platform == self.leader_platform]
        if not candidates:
            self._leader_id = None
            return None
        # Stickiness ends where the engine stops trusting a state; holding a
        # silent leader past that would stall sync with a live one waiting.
        now = time.time()
        current = next(
            (c for c in candidates if c.client_id == self._leader_id and not c.stale(now)),
            None,
        )
        leader = current or max(candidates, key=lambda c: c.updated_at)
        self._leader_id = leader.client_id
        return leader

    def leader(self) -> ClientState | None:
        """The current leader, for callers outside the tick (e.g. queue adds)."""
        clients = [_to_client_state(cid, s) for cid, s in relay.relay.live_states().items()]
        return self._pick_leader(clients)

    def _ready_followers(
        self, leader: ClientState, followers: list[ClientState]
    ) -> list[ClientState]:
        """Followers that have reported since the leader's last track change.

        One that has not cannot have followed yet, so judging it now reads its
        pre-change report as "wrong track". For a follower in the leader's own
        session -- which changes track by itself -- that meant a needless
        playTrack: the song re-inserted and restarted. Costs at most one
        report interval (~1s) on a genuine change.
        """
        if leader.track_id != self._leader_track[0]:
            self._leader_track = (leader.track_id, leader.updated_at)
        changed_at = self._leader_track[1]
        return [f for f in followers if f.updated_at >= changed_at]

    def _hold_repeated_track_changes(
        self, actions: list[engine.Action], now: float
    ) -> list[engine.Action]:
        """Drop a playTrack already sent to that client within the cooldown.

        Its alignment seek goes with it: on its own it would seek the track the
        follower is still playing, which is the wrong one.
        """
        out: list[engine.Action] = []
        held: set[str] = set()
        for action in actions:
            if action.kind == "playTrack":
                last = self._track_commands.get(action.client_id)
                if (
                    last is not None
                    and last[0] == action.value
                    and now - last[1] < TRACK_COMMAND_COOLDOWN_SECONDS
                ):
                    held.add(action.client_id)
                    continue
                self._track_commands[action.client_id] = (action.value, now)
            elif action.client_id in held:
                continue
            out.append(action)
        return out

    # --- tick -------------------------------------------------------------

    def tick(self) -> list[engine.Action]:
        """One pass. Safe to call directly in tests."""
        states = relay.relay.live_states()
        if len(states) < 2:
            return []

        clients = [_to_client_state(cid, s) for cid, s in states.items()]
        leader = self._pick_leader(clients)
        if leader is None:
            return []

        followers = [c for c in clients if c.client_id != leader.client_id]
        if not followers:
            return []

        mapping = {
            platform: self._map_track(leader, platform)
            for platform in {f.platform for f in followers}
        }

        now = time.time()
        # Track identity + position: leader-driven.
        actions = engine.plan(
            leader, self._ready_followers(leader, followers), mapping, _sync_config(), now
        )
        actions = self._hold_repeated_track_changes(actions, now)
        # Play/pause: last-writer-wins across every client, either direction.
        authority = self._transport_authority(clients, now)
        actions += engine.transport_plan(clients, authority)

        for action in actions:
            # Remember our own writes so their echo is not read as user input.
            self.echo.record(action, now)
            target_state = states.get(action.client_id)
            relay.relay.enqueue(
                "command",
                {"action": action.kind, "value": action.value},
                target=action.client_id,
                platform=target_state.platform if target_state else None,
                collapse_key=COLLAPSE_KEYS.get(action.kind),
            )

        self.last_actions = [
            {
                "client_id": a.client_id,
                "kind": a.kind,
                "value": a.value,
                "reason": a.reason,
            }
            for a in actions
        ]
        return actions

    # --- lifecycle --------------------------------------------------------

    def _loop(self) -> None:
        while not self._stop.wait(TICK_SECONDS):
            if not self.enabled:
                continue
            try:
                self.tick()
                self.last_error = None
            except Exception as exc:  # noqa: BLE001 - the loop must survive anything
                self.last_error = str(exc)
                log.exception("sync tick failed")

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, daemon=True, name="sync")
        self._thread.start()
        log.info(
            "sync runner started (leader=%s, enabled=%s)",
            self.leader_platform,
            self.enabled,
        )

    def stop(self) -> None:
        self._stop.set()

    def status(self) -> dict:
        return {
            "enabled": self.enabled,
            "leader_platform": self.leader_platform,
            "running": self._thread is not None and self._thread.is_alive(),
            "last_actions": self.last_actions,
            "last_error": self.last_error,
            "mapping_cache": len(self._mapping_cache),
            "backing_off": len(self._failures),
            "config": {
                "crossfade_ms": _sync_config().crossfade_ms,
                "drift_tolerance_ms": _sync_config().drift_tolerance_ms,
            },
        }


runner = SyncEngineRunner()
