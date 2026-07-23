"""Unit tests for the sync engine's decision logic.

Pure: no network, no clock, no Flask. `now` is injected everywhere so timing
behaviour (staleness, projected position, guard windows) is deterministic.
"""
from __future__ import annotations

import pytest

from matcha.engine import (
    Action,
    ClientState,
    EchoGuard,
    SyncConfig,
    decide,
    in_guard_window,
    plan,
)

NOW = 1_000_000.0
ALL_CAPS = frozenset({"seek", "transport", "queue"})
NO_SEEK = frozenset({"transport"})


def client(
    cid="c",
    platform="spotify",
    track_id="t1",
    position_ms=60_000,
    duration_ms=210_000,
    paused=False,
    caps=ALL_CAPS,
    age_s=0.0,
) -> ClientState:
    return ClientState(
        client_id=cid,
        platform=platform,
        track_id=track_id,
        duration_ms=duration_ms,
        position_ms=position_ms,
        paused=paused,
        capabilities=caps,
        updated_at=NOW - age_s,
    )


def kinds(actions: list[Action]) -> list[str]:
    return [a.kind for a in actions]


# --------------------------------------------------------------------------
# Position projection
# --------------------------------------------------------------------------


def test_position_is_projected_forward_while_playing():
    # Reports arrive ~1Hz; without projection that lag reads as phantom drift.
    c = client(position_ms=60_000, age_s=2.0, paused=False)
    assert c.projected_position_ms(NOW) == pytest.approx(62_000, abs=50)


def test_position_is_not_projected_while_paused():
    c = client(position_ms=60_000, age_s=5.0, paused=True)
    assert c.projected_position_ms(NOW) == 60_000


def test_stale_clients_produce_no_actions():
    leader = client("l", "ytm", track_id="y1", age_s=60)
    follower = client("f", "spotify", track_id="s1")
    assert decide(leader, follower, "s-mapped", now=NOW) == []


# --------------------------------------------------------------------------
# Track identity
# --------------------------------------------------------------------------


def test_wrong_track_triggers_play_then_seek():
    leader = client("l", "ytm", track_id="y1", position_ms=90_000)
    follower = client("f", "spotify", track_id="s-other")
    actions = decide(leader, follower, "s-correct", now=NOW)

    assert kinds(actions)[:2] == ["playTrack", "seek"]
    assert actions[0].value == "s-correct"
    assert actions[1].value == pytest.approx(90_000, abs=100)


def test_wrong_track_without_seek_capability_only_changes_track():
    leader = client("l", "ytm", track_id="y1", position_ms=90_000)
    follower = client("f", "spotify", track_id="s-other", caps=NO_SEEK)
    actions = decide(leader, follower, "s-correct", now=NOW)

    assert "playTrack" in kinds(actions)
    assert "seek" not in kinds(actions)


def test_unmatched_track_leaves_playback_alone():
    # Forcing the wrong song is worse than a brief divergence.
    leader = client("l", "ytm", track_id="y1")
    follower = client("f", "spotify", track_id="s-other")
    actions = decide(leader, follower, None, now=NOW)

    assert "playTrack" not in kinds(actions)
    assert "seek" not in kinds(actions)


def test_correct_track_near_start_is_not_seeked_backwards():
    leader = client("l", "ytm", track_id="y1", position_ms=500)
    follower = client("f", "spotify", track_id="s1", position_ms=0)
    actions = decide(leader, follower, "s1", now=NOW)
    assert "seek" not in kinds(actions)


# --------------------------------------------------------------------------
# Drift
# --------------------------------------------------------------------------


def test_small_drift_is_ignored():
    leader = client("l", "ytm", track_id="y1", position_ms=60_000)
    follower = client("f", "spotify", track_id="s1", position_ms=61_000)
    assert "seek" not in kinds(decide(leader, follower, "s1", now=NOW))


def test_large_drift_triggers_a_seek():
    leader = client("l", "ytm", track_id="y1", position_ms=60_000)
    follower = client("f", "spotify", track_id="s1", position_ms=90_000)
    actions = decide(leader, follower, "s1", now=NOW)

    seeks = [a for a in actions if a.kind == "seek"]
    assert len(seeks) == 1
    assert seeks[0].value == pytest.approx(60_000, abs=100)


def test_drift_is_not_corrected_without_seek_capability():
    leader = client("l", "ytm", track_id="y1", position_ms=60_000)
    follower = client("f", "spotify", track_id="s1", position_ms=90_000, caps=NO_SEEK)
    assert "seek" not in kinds(decide(leader, follower, "s1", now=NOW))


# --------------------------------------------------------------------------
# Crossfade guard window
# --------------------------------------------------------------------------


def test_no_guard_window_when_crossfade_disabled():
    c = client(position_ms=1_000, duration_ms=210_000)
    assert not in_guard_window(c, SyncConfig(crossfade_ms=0), NOW)


def test_guard_window_covers_track_start():
    c = client(position_ms=3_000, duration_ms=210_000)
    assert in_guard_window(c, SyncConfig(crossfade_ms=6_000), NOW)


def test_guard_window_covers_track_end():
    c = client(position_ms=205_000, duration_ms=210_000)
    assert in_guard_window(c, SyncConfig(crossfade_ms=6_000), NOW)


def test_mid_track_is_outside_the_guard_window():
    c = client(position_ms=100_000, duration_ms=210_000)
    assert not in_guard_window(c, SyncConfig(crossfade_ms=6_000), NOW)


def test_drift_is_not_corrected_inside_the_guard_window():
    # Seeking mid-crossfade aborts the fade audibly on that client alone.
    cfg = SyncConfig(crossfade_ms=6_000)
    leader = client("l", "ytm", track_id="y1", position_ms=207_000, duration_ms=210_000)
    follower = client("f", "spotify", track_id="s1", position_ms=180_000, duration_ms=210_000)
    assert "seek" not in kinds(decide(leader, follower, "s1", cfg, now=NOW))


def test_drift_is_corrected_once_past_the_guard_window():
    cfg = SyncConfig(crossfade_ms=6_000)
    leader = client("l", "ytm", track_id="y1", position_ms=100_000, duration_ms=210_000)
    follower = client("f", "spotify", track_id="s1", position_ms=130_000, duration_ms=210_000)
    assert "seek" in kinds(decide(leader, follower, "s1", cfg, now=NOW))


# --------------------------------------------------------------------------
# Transport
# --------------------------------------------------------------------------


def test_decide_no_longer_emits_transport():
    # Transport moved out of decide() into the bidirectional transport_plan.
    leader = client("l", "ytm", track_id="y1", paused=True)
    follower = client("f", "spotify", track_id="s1", paused=False)
    assert "pause" not in kinds(decide(leader, follower, "s1", now=NOW))


# --------------------------------------------------------------------------
# Bidirectional transport (last-writer-wins)
# --------------------------------------------------------------------------


def test_transport_mirrors_authority_pause_to_others():
    from matcha.engine import transport_plan

    a = client("a", "ytm", paused=True)
    b = client("b", "spotify", paused=False)
    actions = transport_plan([a, b], authority_id="a")
    assert [(x.client_id, x.kind) for x in actions] == [("b", "pause")]


def test_transport_authority_can_be_the_spotify_side():
    # The whole point of the request: pausing Spotify pauses YTM too.
    from matcha.engine import transport_plan

    ytm = client("y", "ytm", paused=False)
    spotify = client("s", "spotify", paused=True)
    actions = transport_plan([ytm, spotify], authority_id="s")
    assert [(x.client_id, x.kind) for x in actions] == [("y", "pause")]


def test_transport_no_action_when_all_agree():
    from matcha.engine import transport_plan

    a = client("a", "ytm", paused=False)
    b = client("b", "spotify", paused=False)
    assert transport_plan([a, b], authority_id="a") == []


def test_transport_skips_clients_without_capability():
    from matcha.engine import transport_plan

    a = client("a", "ytm", paused=True)
    b = client("b", "spotify", paused=False, caps=frozenset())
    assert transport_plan([a, b], authority_id="a") == []


def test_transport_no_authority_no_actions():
    from matcha.engine import transport_plan

    a = client("a", "ytm", paused=True)
    b = client("b", "spotify", paused=False)
    assert transport_plan([a, b], authority_id=None) == []


# --------------------------------------------------------------------------
# Echo suppression
# --------------------------------------------------------------------------


def test_echo_guard_recognises_our_own_write():
    guard = EchoGuard()
    guard.record(Action("f", "seek", 60_000, "test"), NOW)
    assert guard.is_echo("f", "seek", 60_000, NOW + 1)


def test_echo_guard_ignores_a_different_value():
    guard = EchoGuard()
    guard.record(Action("f", "seek", 60_000, "test"), NOW)
    assert not guard.is_echo("f", "seek", 99_000, NOW + 1)


def test_echo_guard_expires():
    guard = EchoGuard()
    guard.record(Action("f", "seek", 60_000, "test"), NOW)
    # Past the window this is a genuine user action, not our echo.
    assert not guard.is_echo("f", "seek", 60_000, NOW + 30)


# --------------------------------------------------------------------------
# Multi-follower planning
# --------------------------------------------------------------------------


def test_plan_drives_each_follower_to_its_own_ability():
    # The whole point of capability tiers: a capable client is not held back by
    # a weaker one in the same session.
    leader = client("l", "ytm", track_id="y1", position_ms=60_000)
    capable = client("cap", "spotify", track_id="s1", position_ms=90_000, caps=ALL_CAPS)
    limited = client("lim", "spotify", track_id="s1", position_ms=90_000, caps=NO_SEEK)

    actions = plan(leader, [capable, limited], {"spotify": "s1"}, now=NOW)
    by_client = {a.client_id: kinds([a]) for a in actions}

    assert "seek" in [a.kind for a in actions if a.client_id == "cap"]
    assert "seek" not in [a.kind for a in actions if a.client_id == "lim"]


def test_plan_skips_the_leader_itself():
    leader = client("l", "ytm", track_id="y1")
    actions = plan(leader, [leader], {"ytm": "y1"}, now=NOW)
    assert actions == []


def test_plan_handles_per_platform_mapping():
    leader = client("l", "ytm", track_id="y1", position_ms=60_000)
    spot = client("s", "spotify", track_id="wrong", position_ms=60_000)
    actions = plan(leader, [spot], {"spotify": "s-mapped"}, now=NOW)
    assert any(a.kind == "playTrack" and a.value == "s-mapped" for a in actions)
