"""Service / translation layer.

Validates incoming payloads, drives the match cascade, and maps domain objects
into plain dicts the router can serialize. Raises ValueError for bad input;
the router turns that into a 400.

The cascade, cheapest first:
  1. exact cache hit on (source platform, source id, target platform)
  2. ISRC cross-reference -- a pairing this recording earned in either direction
  3. provider search + scoring
"""
from __future__ import annotations

from dataclasses import asdict

from . import config, logic, providers, relay, store
from .logic import Track

_MAX_BATCH = 100


# --------------------------------------------------------------------------
# Translation
# --------------------------------------------------------------------------


def _to_dict(track: Track) -> dict:
    return asdict(track) | {"artists": list(track.artists)}


def _parse_track(payload: dict) -> Track:
    if not isinstance(payload, dict):
        raise ValueError("'track' must be an object")

    title = payload.get("title")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("'track.title' is required and must be a non-empty string")

    artists = payload.get("artists") or []
    if isinstance(artists, str):
        artists = [artists]
    if not isinstance(artists, list) or not all(isinstance(a, str) for a in artists):
        raise ValueError("'track.artists' must be a list of strings")

    duration = payload.get("duration_ms")
    if duration is not None and not isinstance(duration, (int, float)):
        raise ValueError("'track.duration_ms' must be a number")

    return Track(
        id=str(payload.get("id") or ""),
        title=title.strip(),
        artists=tuple(a.strip() for a in artists if a.strip()),
        album=(payload.get("album") or None),
        duration_ms=int(duration) if duration else None,
        isrc=(payload.get("isrc") or None),
    )


def _parse_platforms(payload: dict) -> tuple[str, str]:
    source = payload.get("source")
    target = payload.get("target")

    if source not in providers.PLATFORMS:
        raise ValueError(
            f"'source' must be one of {', '.join(providers.PLATFORMS)}"
        )

    # With exactly two platforms, target is implied when omitted.
    if target is None:
        target = next(p for p in providers.PLATFORMS if p != source)
    if target not in providers.PLATFORMS:
        raise ValueError(
            f"'target' must be one of {', '.join(providers.PLATFORMS)}"
        )
    if target == source:
        raise ValueError("'source' and 'target' must differ")

    return source, target


def _result(
    *,
    source: str,
    target: str,
    track: dict | None,
    confidence: float | None,
    method: str,
    cached: bool,
    score: logic.Score | None = None,
) -> dict:
    payload = {
        "matched": track is not None,
        "source": source,
        "target": target,
        "track": track,
        "target_id": track["id"] if track else None,
        "confidence": confidence,
        "method": method,
        "cached": cached,
    }
    if score is not None:
        payload["breakdown"] = {
            "title": score.title,
            "artist": score.artist,
            "duration": score.duration,
            "vetoes": list(score.vetoes),
        }
    return payload


# --------------------------------------------------------------------------
# Matching
# --------------------------------------------------------------------------


def match(payload: dict) -> dict:
    """Resolve one track onto the other platform."""
    if not isinstance(payload, dict):
        raise ValueError("request body must be a JSON object")

    source, target = _parse_platforms(payload)
    track = _parse_track(payload.get("track") or {})

    # 1. Exact cache hit. Only possible when the caller gave us a stable id.
    if track.id:
        hit = store.lookup(source, track.id, target)
        if hit is not None:
            return _result(
                source=source,
                target=target,
                track=hit["track"],
                confidence=hit["confidence"],
                method=hit["method"],
                cached=True,
            )

    # 2. ISRC cross-reference. The same recording may already have been paired
    #    from the other direction, by this caller or a previous session.
    if track.isrc:
        hit = store.lookup_by_isrc(track.isrc, target)
        if hit is not None:
            if track.id:
                store.save(
                    source,
                    track.id,
                    target,
                    Track(**{**hit["track"], "artists": tuple(hit["track"]["artists"])}),
                    hit["confidence"],
                    "isrc",
                    isrc=track.isrc,
                )
            return _result(
                source=source,
                target=target,
                track=hit["track"],
                confidence=hit["confidence"],
                method="isrc",
                cached=True,
            )

    # 3. Search the target platform and score what comes back.
    provider = providers.get(target)
    candidates = provider.search(track, config.SEARCH_LIMIT)
    best = logic.best_match(track, candidates)

    if best is None:
        if track.id:
            store.save(source, track.id, target, None, None, "search", isrc=track.isrc)
        return _result(
            source=source,
            target=target,
            track=None,
            confidence=None,
            method="search",
            cached=False,
        )

    candidate, score = best

    # Below threshold is a miss, but we return the near-match so the caller can
    # log what it nearly picked.
    if not score.matched:
        if track.id:
            store.save(source, track.id, target, None, None, "search", isrc=track.isrc)
        return _result(
            source=source,
            target=target,
            track=None,
            confidence=score.confidence,
            method="search",
            cached=False,
            score=score,
        ) | {"rejected": _to_dict(candidate)}

    if track.id:
        store.save(
            source,
            track.id,
            target,
            candidate,
            score.confidence,
            "search",
            isrc=track.isrc or candidate.isrc,
        )

    return _result(
        source=source,
        target=target,
        track=_to_dict(candidate),
        confidence=score.confidence,
        method="search",
        cached=False,
        score=score,
    )


def match_batch(payload: dict) -> dict:
    """Resolve many tracks in one call, for queue and playlist sync.

    A failure on one track never fails the batch -- callers get a per-item
    result so a single unmatched song can't stall a queue.
    """
    if not isinstance(payload, dict):
        raise ValueError("request body must be a JSON object")

    tracks = payload.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        raise ValueError("'tracks' is required and must be a non-empty list")
    if len(tracks) > _MAX_BATCH:
        raise ValueError(f"'tracks' may contain at most {_MAX_BATCH} items")

    source, target = _parse_platforms(payload)

    results = []
    for index, item in enumerate(tracks):
        try:
            results.append(
                match({"source": source, "target": target, "track": item})
            )
        except ValueError as exc:
            results.append({"matched": False, "index": index, "error": str(exc)})
        except providers.ProviderError as exc:
            results.append({"matched": False, "index": index, "error": str(exc)})

    return {
        "source": source,
        "target": target,
        "count": len(results),
        "matched": sum(1 for r in results if r.get("matched")),
        "results": results,
    }


# --------------------------------------------------------------------------
# Diagnostics
# --------------------------------------------------------------------------


def health() -> dict:
    return {
        "status": "ok",
        "providers": providers.availability(),
        "routes": providers.routes(),
        "auth": "token" if config.TOKEN else "none",
    }


def cache_stats() -> dict:
    return store.stats()


# --------------------------------------------------------------------------
# spice-ify relay
# --------------------------------------------------------------------------


def report_playback(payload: dict) -> dict:
    """A spice-ify client reports what its local Spotify is doing."""
    if not isinstance(payload, dict):
        raise ValueError("request body must be a JSON object")

    client_id = payload.get("client_id")
    if not isinstance(client_id, str) or not client_id.strip():
        raise ValueError("'client_id' is required and must be a non-empty string")

    state_in = payload.get("state") or {}
    artists = state_in.get("artists") or []
    if isinstance(artists, str):
        artists = [artists]

    caps = state_in.get("capabilities") or []
    if isinstance(caps, str):
        caps = [caps]

    relay.relay.report_state(
        client_id.strip(),
        relay.PlaybackState(
            platform=state_in.get("platform", payload.get("platform", "spotify")),
            capabilities=tuple(c for c in caps if isinstance(c, str)),
            track_id=state_in.get("track_id"),
            title=state_in.get("title"),
            artists=tuple(a for a in artists if isinstance(a, str)),
            album=state_in.get("album"),
            duration_ms=state_in.get("duration_ms"),
            position_ms=state_in.get("position_ms"),
            paused=bool(state_in.get("paused", True)),
        ),
    )
    return {"ok": True}


def playback_states() -> dict:
    return {"clients": relay.relay.states()}


def take_pending(payload: dict) -> dict:
    """A client claims work. Claimed items are handed out once only."""
    payload = payload or {}
    limit = payload.get("limit", 10)
    if not isinstance(limit, int) or not 1 <= limit <= 50:
        raise ValueError("'limit' must be an integer between 1 and 50")
    return {
        "requests": relay.relay.take_pending(
            limit, payload.get("client_id"), payload.get("platform")
        )
    }


def sync_status() -> dict:
    from . import runner
    return runner.runner.status()


def sync_set(payload: dict) -> dict:
    """Enable/disable syncing, or change which platform leads."""
    from . import runner
    if not isinstance(payload, dict):
        raise ValueError("request body must be a JSON object")

    if "enabled" in payload:
        if not isinstance(payload["enabled"], bool):
            raise ValueError("'enabled' must be a boolean")
        runner.runner.enabled = payload["enabled"]

    if "leader" in payload:
        if payload["leader"] not in providers.PLATFORMS:
            raise ValueError(f"'leader' must be one of {', '.join(providers.PLATFORMS)}")
        runner.runner.leader_platform = payload["leader"]

    return runner.runner.status()


def sync_tick() -> dict:
    """Run one tick immediately -- for testing without waiting for the loop."""
    from . import runner
    actions = runner.runner.tick()
    return {"actions": runner.runner.last_actions, "count": len(actions)}


def complete_request(payload: dict) -> dict:
    """A spice-ify client returns a result for claimed work."""
    if not isinstance(payload, dict):
        raise ValueError("request body must be a JSON object")

    request_id = payload.get("id")
    if not isinstance(request_id, str) or not request_id:
        raise ValueError("'id' is required")

    accepted = relay.relay.complete(request_id, payload.get("result") or {})
    if not accepted:
        # Almost always a timeout that already gave up; not worth a 4xx.
        return {"ok": False, "reason": "unknown or expired request id"}
    return {"ok": True}


def send_command(payload: dict) -> dict:
    """Queue a playback command for a spice-ify client.

    This is how the sync engine drives a Spotify participant that has no usable
    Web API access -- the extension polls, executes locally, and answers.
    """
    if not isinstance(payload, dict):
        raise ValueError("request body must be a JSON object")

    action = payload.get("action")
    valid = {"play", "pause", "next", "previous", "seek", "queue", "playTrack"}
    if action not in valid:
        raise ValueError(f"'action' must be one of {', '.join(sorted(valid))}")

    if action in ("seek", "queue", "playTrack") and payload.get("value") is None:
        raise ValueError(f"'value' is required for action '{action}'")

    spotify_clients = relay.relay.live_clients("spotify")
    if not spotify_clients:
        raise ProviderUnavailable("no spice-ify client is connected")

    request_id = relay.relay.enqueue(
        "command",
        {"action": action, "value": payload.get("value")},
        target=payload.get("client_id") or spotify_clients[0],
        platform="spotify",
    )

    wait = payload.get("wait", True)
    if not wait:
        return {"id": request_id, "queued": True}

    result = relay.relay.wait_for(request_id, timeout=float(payload.get("timeout", 10)))
    if result is None:
        raise ProviderUnavailable(f"spice-ify did not answer '{action}' in time")
    return {"id": request_id, "result": result}


def relay_stats() -> dict:
    return relay.relay.stats()


class ProviderUnavailable(RuntimeError):
    """A dependency is reachable but cannot serve the request right now."""


def cache_clear() -> dict:
    return {"cleared": store.clear()}
