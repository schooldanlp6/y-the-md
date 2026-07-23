"""Sync engine — pure decision logic.

Given the leader's state and one follower's state, decide what to do about it.
No HTTP, no network, no clock reads beyond what is passed in: everything here is
a pure function of its arguments, which is what makes the hard parts testable.

The contract, from AGENTS.md constraint 8: **"the leader is playing track X at
position P — make that true here too."** Explicit track selection plus a seek.
Queue manipulation is an optimisation layered on top, never the mechanism.

Design notes worth keeping:

- **Strict leader/follower removes most echo risk by construction.** Only the
  leader's state produces actions; followers are write-only targets, so a change
  we push cannot come back as a change that pushes again. Echo suppression below
  exists for the moment a follower is allowed to initiate.
- **Capabilities are per-client.** A follower without `seek` still gets track
  changes and transport; it simply drifts within tolerance. Never degrade every
  client to the weakest one (AGENTS.md -> Capability tiers).
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

# --------------------------------------------------------------------------
# Tuning
# --------------------------------------------------------------------------

#: Drift we tolerate before issuing a seek. Music Together itself tolerates 3s,
#: and Web API seeks land 200-500ms late, so chasing tighter is wasted effort.
DRIFT_TOLERANCE_MS = 2_500

#: Extra margin either side of a crossfade where positions are ambiguous.
GUARD_MARGIN_MS = 1_000

#: A state older than this is not worth acting on.
STALE_AFTER_MS = 15_000

#: How long one of our own writes stays "expected" before an echo of it counts
#: as a genuine user action.
ECHO_WINDOW_MS = 5_000

#: A follower within this of the leader's track change is mid-transition; let it
#: settle rather than fighting it.
TRANSITION_SETTLE_MS = 2_000


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ClientState:
    """What one participant's player is doing, as last reported."""

    client_id: str
    platform: str
    track_id: str | None = None
    title: str | None = None
    duration_ms: int | None = None
    position_ms: int | None = None
    paused: bool = True
    capabilities: frozenset[str] = frozenset()
    updated_at: float = 0.0

    def age_ms(self, now: float) -> float:
        return (now - self.updated_at) * 1000

    def stale(self, now: float) -> bool:
        return self.age_ms(now) > STALE_AFTER_MS

    def can(self, capability: str) -> bool:
        return capability in self.capabilities

    def projected_position_ms(self, now: float) -> int | None:
        """Position advanced by however long ago the report was.

        Reports arrive at ~1 Hz, so comparing raw positions would show up to a
        second of phantom drift purely from staleness.
        """
        if self.position_ms is None:
            return None
        if self.paused:
            return self.position_ms
        return int(self.position_ms + self.age_ms(now))


@dataclass(frozen=True)
class Action:
    """Something to tell a client to do."""

    client_id: str
    kind: str  # playTrack | seek | play | pause
    value: object | None
    reason: str


@dataclass
class EchoGuard:
    """Remembers our own writes so their echoes are not mistaken for input.

    Only matters once followers may initiate changes; harmless before that.
    """

    _recent: dict[tuple[str, str], tuple[object, float]] = field(default_factory=dict)

    def record(self, action: Action, now: float) -> None:
        self._recent[(action.client_id, action.kind)] = (action.value, now)

    def is_echo(self, client_id: str, kind: str, value: object, now: float) -> bool:
        entry = self._recent.get((client_id, kind))
        if entry is None:
            return False
        expected, at = entry
        if (now - at) * 1000 > ECHO_WINDOW_MS:
            del self._recent[(client_id, kind)]
            return False
        return expected == value

    def forget(self, client_id: str) -> None:
        for key in [k for k in self._recent if k[0] == client_id]:
            del self._recent[key]


@dataclass(frozen=True)
class SyncConfig:
    """Session-wide settings. Crossfade must match everywhere — constraint 11."""

    crossfade_ms: int = 0
    drift_tolerance_ms: int = DRIFT_TOLERANCE_MS
    guard_margin_ms: int = GUARD_MARGIN_MS


# --------------------------------------------------------------------------
# Guard window
# --------------------------------------------------------------------------


def in_guard_window(state: ClientState, config: SyncConfig, now: float) -> bool:
    """True if we are close enough to a track boundary that seeking is unsafe.

    During a crossfade two tracks are audible, reported positions are ambiguous,
    and a seek aborts the fade audibly on that client alone. So we let drift ride
    through the transition and correct afterwards (AGENTS.md constraint 11).
    """
    if config.crossfade_ms <= 0:
        return False

    position = state.projected_position_ms(now)
    if position is None:
        return False

    window = config.crossfade_ms + config.guard_margin_ms

    # Just after a track began.
    if position <= window:
        return True

    # Approaching the end, where the next track starts fading in.
    if state.duration_ms is not None and state.duration_ms - position <= window:
        return True

    return False


# --------------------------------------------------------------------------
# Decision
# --------------------------------------------------------------------------


def decide(
    leader: ClientState,
    follower: ClientState,
    mapped_track_id: str | None,
    config: SyncConfig | None = None,
    now: float | None = None,
) -> list[Action]:
    """What should `follower` do to match `leader`?

    `mapped_track_id` is the leader's current track resolved onto the follower's
    platform (matcha's job). `None` means unmatched — we then leave the track
    alone and only mirror play/pause, because forcing something wrong is worse
    than a brief divergence.
    """
    config = config or SyncConfig()
    now = time.time() if now is None else now

    if leader.client_id == follower.client_id:
        return []
    if leader.stale(now) or follower.stale(now):
        return []

    actions: list[Action] = []

    # 1. Track identity first: everything else is meaningless on the wrong track.
    on_wrong_track = mapped_track_id is not None and follower.track_id != mapped_track_id

    if on_wrong_track:
        actions.append(
            Action(
                follower.client_id,
                "playTrack",
                mapped_track_id,
                f"follower on {follower.track_id}, leader on {leader.track_id}",
            )
        )
        # Land at the leader's position rather than the start, but only when the
        # follower can seek and we are not inside a crossfade.
        leader_position = leader.projected_position_ms(now)
        if (
            follower.can("seek")
            and leader_position is not None
            and leader_position > config.drift_tolerance_ms
            and not in_guard_window(leader, config, now)
        ):
            actions.append(
                Action(
                    follower.client_id,
                    "seek",
                    leader_position,
                    "align to leader position after track change",
                )
            )
        # Don't also correct drift this tick; the track change has to land first.
        # Transport (play/pause) is handled separately and bidirectionally --
        # see transport_plan.
        return actions

    # 2. Drift, but only on the right track and outside the guard window.
    if mapped_track_id is not None and follower.can("seek"):
        leader_position = leader.projected_position_ms(now)
        follower_position = follower.projected_position_ms(now)

        if leader_position is not None and follower_position is not None:
            drift = leader_position - follower_position
            if abs(drift) > config.drift_tolerance_ms:
                if in_guard_window(leader, config, now) or in_guard_window(
                    follower, config, now
                ):
                    pass  # mid-crossfade: let it ride, correct after
                else:
                    actions.append(
                        Action(
                            follower.client_id,
                            "seek",
                            leader_position,
                            f"drift {drift:+.0f}ms exceeds {config.drift_tolerance_ms}ms",
                        )
                    )

    # Transport is handled separately and bidirectionally -- see transport_plan.
    return actions


def transport_plan(
    clients: list[ClientState],
    authority_id: str | None,
) -> list[Action]:
    """Mirror the authority's play/pause state to every other client.

    Play/pause is **last-writer-wins**, not leader-driven: whoever most recently
    changed it (on either platform) is the authority, and everyone else follows.
    The runner decides who the authority is (it needs history to tell a real user
    action from an echo of our own command); this stays a pure mirror.
    """
    if authority_id is None:
        return []

    authority = next((c for c in clients if c.client_id == authority_id), None)
    if authority is None:
        return []

    actions: list[Action] = []
    for client in clients:
        if client.client_id == authority_id:
            continue
        if not client.can("transport"):
            continue
        if client.paused != authority.paused:
            actions.append(
                Action(
                    client.client_id,
                    "pause" if authority.paused else "play",
                    None,
                    f"{authority_id} {'paused' if authority.paused else 'resumed'}",
                )
            )
    return actions


def plan(
    leader: ClientState,
    followers: list[ClientState],
    mapping: dict[str, str | None],
    config: SyncConfig | None = None,
    now: float | None = None,
) -> list[Action]:
    """Decide for every follower.

    `mapping` maps a follower's platform to the leader's current track resolved
    onto it. Each follower is driven to the best of *its own* ability, never
    reduced to the weakest participant.
    """
    actions: list[Action] = []
    for follower in followers:
        actions.extend(
            decide(leader, follower, mapping.get(follower.platform), config, now)
        )
    return actions
