"""Tests for session-queue forwarding and leader selection.

No network: matching is monkeypatched, and the leader's side of the relay is
played by a background thread that claims and answers work the way y-the-md
does.
"""
from __future__ import annotations

import threading
import time

import pytest

from matcha import relay as relay_mod
from matcha import runner as runner_mod
from matcha import service
from matcha.relay import PlaybackState, Relay


@pytest.fixture
def relay(monkeypatch) -> Relay:
    fresh = Relay()
    monkeypatch.setattr(relay_mod, "relay", fresh)
    return fresh


@pytest.fixture(autouse=True)
def saved(monkeypatch) -> list:
    """Record cache writes instead of touching the real matches.db."""
    calls: list = []
    monkeypatch.setattr(service.store, "save", lambda *args, **kwargs: calls.append(args))
    return calls


@pytest.fixture
def runner(monkeypatch, relay) -> runner_mod.SyncEngineRunner:
    fresh = runner_mod.SyncEngineRunner(leader_platform="ytm")
    monkeypatch.setattr(runner_mod, "runner", fresh)
    return fresh


def report(relay: Relay, cid: str, platform: str, track_id: str = "t", age_s: float = 0.0):
    relay.report_state(
        cid,
        PlaybackState(
            platform=platform,
            track_id=track_id,
            title="Song",
            artists=("Artist",),
            duration_ms=200_000,
            position_ms=10_000,
            paused=False,
            updated_at=time.time() - age_s,
        ),
    )


def answer_as(relay: Relay, cid: str, platform: str, result: dict) -> tuple[threading.Thread, list]:
    """Claim the next request addressed to `cid` and answer it with `result`."""
    seen: list = []

    def work():
        deadline = time.time() + 5
        while time.time() < deadline:
            for req in relay.take_pending(client_id=cid, platform=platform):
                seen.append(req)
                relay.complete(req["id"], result)
                return
            time.sleep(0.01)

    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    return thread, seen


def matched(target_id: str) -> dict:
    return {
        "matched": True,
        "target_id": target_id,
        "track": {"id": target_id, "title": "Song", "artists": ["Artist"]},
    }


SPOTIFY_TRACK = {"id": "spotify:track:abc", "title": "Song", "artists": ["Artist"], "duration_ms": 200_000}


# --------------------------------------------------------------------------
# Leader selection
# --------------------------------------------------------------------------


def test_leader_is_sticky_while_it_stays_live(relay, runner):
    report(relay, "ytm-a", "ytm")
    assert runner.leader().client_id == "ytm-a"

    # A second client on the leader platform reports more recently; with plain
    # "most recently updated" leadership would flip to it every tick.
    report(relay, "ytm-b", "ytm")
    assert runner.leader().client_id == "ytm-a"


def test_leadership_moves_when_the_leader_goes_stale(relay, runner):
    report(relay, "ytm-a", "ytm")
    assert runner.leader().client_id == "ytm-a"

    report(relay, "ytm-a", "ytm", age_s=600)
    report(relay, "ytm-b", "ytm")
    assert runner.leader().client_id == "ytm-b"


def test_no_leader_without_a_client_on_the_leader_platform(relay, runner):
    report(relay, "sp-1", "spotify")
    assert runner.leader() is None


def test_same_platform_follower_maps_to_the_leaders_own_id(relay, runner, monkeypatch):
    def no_match(_payload):
        raise AssertionError("same-platform followers must not go through matching")

    monkeypatch.setattr(service, "match", no_match)
    runner.leader_platform = "spotify"
    report(relay, "sp-1", "spotify", track_id="spotify:track:lead")
    assert runner.leader().client_id == "sp-1"
    report(relay, "sp-2", "spotify", track_id="spotify:track:other")

    actions = runner.tick()

    assert [(a.client_id, a.kind, a.value) for a in actions if a.kind == "playTrack"] == [
        ("sp-2", "playTrack", "spotify:track:lead")
    ]


# --------------------------------------------------------------------------
# queue_add
# --------------------------------------------------------------------------


def test_spotify_add_is_matched_and_written_to_the_leader(relay, runner, monkeypatch):
    monkeypatch.setattr(service, "match", lambda payload: matched("vid123"))
    report(relay, "ytm-host", "ytm")
    report(relay, "sp-1", "spotify")
    thread, seen = answer_as(relay, "ytm-host", "ytm", {"ok": True, "index": 4})

    result = service.queue_add({"client_id": "sp-1", "track": SPOTIFY_TRACK})
    thread.join()

    assert result["queued"] is True
    assert result["target_id"] == "vid123"
    assert result["index"] == 4
    assert seen[0]["payload"] == {
        "action": "queue",
        "value": "vid123",
        "key": "spotify:spotify:track:abc",
    }


def test_confirmed_add_pins_the_reverse_pairing(relay, runner, monkeypatch, saved):
    monkeypatch.setattr(service, "match", lambda payload: matched("vid123") | {"confidence": 0.97})
    report(relay, "ytm-host", "ytm")
    report(relay, "sp-1", "spotify")
    thread, _ = answer_as(relay, "ytm-host", "ytm", {"ok": True})

    service.queue_add({"client_id": "sp-1", "track": SPOTIFY_TRACK})
    thread.join()

    source_platform, source_id, target_platform, track, confidence, _method = saved[0]
    assert (source_platform, source_id, target_platform) == ("ytm", "vid123", "spotify")
    assert track.id == "spotify:track:abc"
    assert confidence == 0.97


def test_refused_add_pins_nothing(relay, runner, monkeypatch, saved):
    monkeypatch.setattr(service, "match", lambda payload: matched("vid123"))
    report(relay, "ytm-host", "ytm")
    report(relay, "sp-1", "spotify")
    thread, _ = answer_as(relay, "ytm-host", "ytm", {"ok": False, "error": "nope"})

    service.queue_add({"client_id": "sp-1", "track": SPOTIFY_TRACK})
    thread.join()

    assert saved == []


def test_platform_is_inferred_from_the_reporting_client(relay, runner, monkeypatch):
    calls = []

    def fake_match(payload):
        calls.append(payload)
        return matched("vid123")

    monkeypatch.setattr(service, "match", fake_match)
    report(relay, "ytm-host", "ytm")
    report(relay, "sp-1", "spotify")
    thread, _ = answer_as(relay, "ytm-host", "ytm", {"ok": True})

    service.queue_add({"client_id": "sp-1", "track": SPOTIFY_TRACK})
    thread.join()

    assert (calls[0]["source"], calls[0]["target"]) == ("spotify", "ytm")


def test_no_match_is_an_answer_and_writes_nothing(relay, runner, monkeypatch):
    monkeypatch.setattr(service, "match", lambda payload: {"matched": False, "target_id": None})
    report(relay, "ytm-host", "ytm")
    report(relay, "sp-1", "spotify")

    result = service.queue_add({"client_id": "sp-1", "track": SPOTIFY_TRACK})

    assert result["queued"] is False
    assert relay.take_pending(client_id="ytm-host", platform="ytm") == []


def test_leader_refusal_is_reported_not_raised(relay, runner, monkeypatch):
    monkeypatch.setattr(service, "match", lambda payload: matched("vid123"))
    report(relay, "ytm-host", "ytm")
    report(relay, "sp-1", "spotify")
    thread, _ = answer_as(relay, "ytm-host", "ytm", {"ok": False, "error": "no queue hook"})

    result = service.queue_add({"client_id": "sp-1", "track": SPOTIFY_TRACK})
    thread.join()

    assert result["queued"] is False
    assert "no queue hook" in result["reason"]


def test_no_leader_raises_unavailable(relay, runner):
    report(relay, "sp-1", "spotify")
    with pytest.raises(service.ProviderUnavailable):
        service.queue_add({"client_id": "sp-1", "track": SPOTIFY_TRACK})


def test_silent_leader_raises_unavailable(relay, runner, monkeypatch):
    monkeypatch.setattr(service, "match", lambda payload: matched("vid123"))
    monkeypatch.setattr(service, "QUEUE_ADD_TIMEOUT_SECONDS", 0.05)
    report(relay, "ytm-host", "ytm")
    report(relay, "sp-1", "spotify")

    with pytest.raises(service.ProviderUnavailable):
        service.queue_add({"client_id": "sp-1", "track": SPOTIFY_TRACK})


def test_the_leaders_own_add_is_not_forwarded(relay, runner):
    report(relay, "ytm-host", "ytm")
    result = service.queue_add(
        {"client_id": "ytm-host", "track": {"id": "vid1", "title": "Song", "artists": ["A"]}}
    )
    assert result["queued"] is False
    assert relay.take_pending(platform="ytm") == []


def test_same_platform_add_forwards_the_id_unmatched(relay, runner, monkeypatch):
    def no_match(_payload):
        raise AssertionError("same-platform adds must not go through matching")

    monkeypatch.setattr(service, "match", no_match)
    runner.leader_platform = "spotify"
    report(relay, "sp-lead", "spotify")
    assert runner.leader().client_id == "sp-lead"
    report(relay, "sp-2", "spotify")
    thread, seen = answer_as(relay, "sp-lead", "spotify", {"ok": True})

    result = service.queue_add({"client_id": "sp-2", "track": SPOTIFY_TRACK})
    thread.join()

    assert result["queued"] is True
    assert seen[0]["payload"]["value"] == "spotify:track:abc"


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"client_id": "", "track": SPOTIFY_TRACK},
        {"client_id": "sp-1", "track": {"artists": ["A"]}},
        {"client_id": "unknown-client", "track": SPOTIFY_TRACK},
    ],
)
def test_bad_input_is_a_value_error(relay, runner, payload):
    report(relay, "ytm-host", "ytm")
    with pytest.raises(ValueError):
        service.queue_add(payload)


def test_a_second_report_of_the_same_track_is_a_duplicate(relay, runner, monkeypatch):
    """Listeners in one Spotify Jam all see the same queued track."""
    calls = []

    def fake_match(payload):
        calls.append(payload)
        return matched("vid123")

    monkeypatch.setattr(service, "match", fake_match)
    report(relay, "ytm-host", "ytm")
    report(relay, "sp-1", "spotify")
    report(relay, "sp-2", "spotify")
    thread, seen = answer_as(relay, "ytm-host", "ytm", {"ok": True, "index": 3})

    first = service.queue_add({"client_id": "sp-1", "track": SPOTIFY_TRACK})
    thread.join()
    second = service.queue_add({"client_id": "sp-2", "track": SPOTIFY_TRACK})

    assert first["queued"] is True and second["queued"] is True
    assert second.get("duplicate") is True
    assert len(seen) == 1 and len(calls) == 1
    assert relay.take_pending(platform="ytm") == []


def test_concurrent_duplicates_insert_once(relay, runner, monkeypatch):
    monkeypatch.setattr(service, "match", lambda payload: matched("vid123"))
    report(relay, "ytm-host", "ytm")
    report(relay, "sp-1", "spotify")
    report(relay, "sp-2", "spotify")
    worker, seen = answer_as(relay, "ytm-host", "ytm", {"ok": True})

    results: dict = {}

    def add(cid):
        results[cid] = service.queue_add({"client_id": cid, "track": SPOTIFY_TRACK})

    threads = [threading.Thread(target=add, args=(cid,)) for cid in ("sp-1", "sp-2")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)
    worker.join()

    assert len(seen) == 1
    assert all(r["queued"] for r in results.values())
    assert sum(1 for r in results.values() if r.get("duplicate")) == 1


def test_a_failed_add_is_retried_not_deduplicated(relay, runner, monkeypatch):
    monkeypatch.setattr(service, "match", lambda payload: matched("vid123"))
    report(relay, "ytm-host", "ytm")
    report(relay, "sp-1", "spotify")

    thread, _ = answer_as(relay, "ytm-host", "ytm", {"ok": False, "error": "busy"})
    assert service.queue_add({"client_id": "sp-1", "track": SPOTIFY_TRACK})["queued"] is False
    thread.join()

    thread, seen = answer_as(relay, "ytm-host", "ytm", {"ok": True})
    retry = service.queue_add({"client_id": "sp-1", "track": SPOTIFY_TRACK})
    thread.join()

    assert retry["queued"] is True and "duplicate" not in retry
    assert len(seen) == 1


def test_leader_self_add_is_flagged(relay, runner):
    report(relay, "ytm-host", "ytm")
    result = service.queue_add(
        {"client_id": "ytm-host", "track": {"id": "vid1", "title": "Song", "artists": ["A"]}}
    )
    assert result["is_leader"] is True


def test_unconfirmed_write_is_retryable_not_refused(relay, runner, monkeypatch, saved):
    """The write may still land: the caller must retry, not keep its own copy."""
    monkeypatch.setattr(service, "match", lambda payload: matched("vid123"))
    report(relay, "ytm-host", "ytm")
    report(relay, "sp-1", "spotify")
    thread, _ = answer_as(relay, "ytm-host", "ytm", {"ok": False, "unconfirmed": True})

    with pytest.raises(service.ProviderUnavailable):
        service.queue_add({"client_id": "sp-1", "track": SPOTIFY_TRACK})
    thread.join()
    assert saved == []


def test_unclaimed_commands_collapse_per_target_and_key(relay):
    report(relay, "c1", "ytm")
    report(relay, "c2", "ytm")
    first = relay.enqueue("command", {"action": "playTrack", "value": "a"}, target="c1", collapse_key="playTrack")
    second = relay.enqueue("command", {"action": "playTrack", "value": "b"}, target="c1", collapse_key="playTrack")
    other = relay.enqueue("command", {"action": "playTrack", "value": "x"}, target="c2", collapse_key="playTrack")

    assert first == second and other != first
    pending = relay.take_pending(client_id="c1")
    assert [r["payload"]["value"] for r in pending] == ["b"]


def test_queue_writes_never_collapse(relay):
    a = relay.enqueue("command", {"action": "queue", "value": "v1"}, target="c1")
    b = relay.enqueue("command", {"action": "queue", "value": "v2"}, target="c1")
    assert a != b


# --------------------------------------------------------------------------
# Runner: repeats, settling, stale leaders
# --------------------------------------------------------------------------


def _follower_setup(relay, runner, monkeypatch):
    monkeypatch.setattr(runner_mod.SyncEngineRunner, "_map_track", lambda self, leader, platform: "spotify:track:mapped")
    report(relay, "ytm-host", "ytm", track_id="vid-lead")
    report(relay, "sp-1", "spotify", track_id="spotify:track:wrong")


def test_play_track_is_not_resent_while_the_first_lands(relay, runner, monkeypatch):
    _follower_setup(relay, runner, monkeypatch)

    first = [a.kind for a in runner.tick() if a.client_id == "sp-1"]
    report(relay, "sp-1", "spotify", track_id="spotify:track:wrong")  # still landing
    second = [a.kind for a in runner.tick() if a.client_id == "sp-1"]

    assert "playTrack" in first
    assert "playTrack" not in second and "seek" not in second


def test_play_track_is_resent_after_the_cooldown(relay, runner, monkeypatch):
    _follower_setup(relay, runner, monkeypatch)
    runner.tick()
    runner._track_commands["sp-1"] = ("spotify:track:mapped", time.time() - 60)

    report(relay, "sp-1", "spotify", track_id="spotify:track:wrong")
    assert "playTrack" in [a.kind for a in runner.tick() if a.client_id == "sp-1"]


def test_follower_is_not_judged_on_a_report_older_than_the_leaders_change(relay, runner, monkeypatch):
    _follower_setup(relay, runner, monkeypatch)
    runner.tick()

    # Leader moves on; the follower has not reported since.
    report(relay, "sp-1", "spotify", track_id="spotify:track:mapped", age_s=0.5)
    report(relay, "ytm-host", "ytm", track_id="vid-next")
    assert [a for a in runner.tick() if a.kind == "playTrack"] == []


def test_a_silent_leader_hands_over_before_it_times_out(relay, runner):
    report(relay, "ytm-a", "ytm")
    assert runner.leader().client_id == "ytm-a"

    # Past the engine's staleness (15s) but not yet dropped by the relay (30s).
    report(relay, "ytm-a", "ytm", age_s=20)
    report(relay, "ytm-b", "ytm")
    assert runner.leader().client_id == "ytm-b"
