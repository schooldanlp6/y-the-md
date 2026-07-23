"""Router / Controller layer.

HTTP only: read the request, call the service, shape the response, pick the
status code. No business logic lives here.

Every route is under /api/v1 -- the prefix comes from the blueprint, never from
individual route strings.
"""
from __future__ import annotations

from flask import Blueprint, jsonify, request

from . import providers, service

api = Blueprint("api", __name__, url_prefix="/api/v1")


def _json_body() -> dict:
    return request.get_json(silent=True) or {}


@api.get("/health")
def health():
    return jsonify(service.health())


@api.post("/match")
def match():
    try:
        result = service.match(_json_body())
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except providers.ProviderError as exc:
        return jsonify({"error": str(exc)}), 503
    return jsonify(result)


@api.post("/match/batch")
def match_batch():
    try:
        result = service.match_batch(_json_body())
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except providers.ProviderError as exc:
        return jsonify({"error": str(exc)}), 503
    return jsonify(result)


@api.get("/cache")
def cache_stats():
    return jsonify(service.cache_stats())


# --- spice-ify relay -------------------------------------------------------
# A Spicetify extension cannot listen on a port, so it polls here for work and
# posts results back. See matcha/relay.py.


@api.post("/spotify/state")
def report_playback():
    try:
        return jsonify(service.report_playback(_json_body()))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@api.get("/spotify/state")
def playback_states():
    return jsonify(service.playback_states())


@api.post("/spotify/pending")
def take_pending():
    body = _json_body()
    body.setdefault("platform", "spotify")
    try:
        return jsonify(service.take_pending(body))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@api.post("/spotify/result")
def complete_request():
    try:
        return jsonify(service.complete_request(_json_body()))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@api.post("/spotify/command")
def send_command():
    try:
        return jsonify(service.send_command(_json_body()))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except service.ProviderUnavailable as exc:
        return jsonify({"error": str(exc)}), 503


@api.post("/ytm/state")
def report_ytm_state():
    body = _json_body()
    body.setdefault("platform", "ytm")
    body.setdefault("state", {}).setdefault("platform", "ytm")
    try:
        return jsonify(service.report_playback(body))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@api.post("/ytm/pending")
def take_ytm_pending():
    body = _json_body()
    body.setdefault("platform", "ytm")
    try:
        return jsonify(service.take_pending(body))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@api.post("/ytm/result")
def complete_ytm_request():
    try:
        return jsonify(service.complete_request(_json_body()))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


# --- sync engine -----------------------------------------------------------


@api.get("/sync")
def sync_status():
    return jsonify(service.sync_status())


@api.post("/sync")
def sync_set():
    try:
        return jsonify(service.sync_set(_json_body()))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@api.post("/sync/tick")
def sync_tick():
    return jsonify(service.sync_tick())


@api.get("/spotify/relay")
def relay_stats():
    return jsonify(service.relay_stats())


@api.delete("/cache")
def cache_clear():
    return jsonify(service.cache_clear())
