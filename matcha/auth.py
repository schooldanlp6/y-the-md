"""Bearer-token guard.

The matcha has exactly one caller (the bridge) and stores no user data or
platform credentials, so a single shared secret is the whole model. When
`MATCHER_TOKEN` is unset the guard does nothing -- the intended default is to
bind 127.0.0.1 and let the network be the boundary.
"""
from __future__ import annotations

import hmac

from flask import jsonify, request

from . import config

# Unauthenticated, so a liveness probe works without handing out the token.
_EXEMPT_ENDPOINTS = frozenset({"api.health"})


def require_token():
    """`before_request` hook. Returns a response to short-circuit, else None."""
    if not config.TOKEN:
        return None
    if request.endpoint in _EXEMPT_ENDPOINTS:
        return None
    if request.method == "OPTIONS":
        return None

    header = request.headers.get("Authorization", "")
    scheme, _, presented = header.partition(" ")

    if scheme.lower() != "bearer" or not presented:
        return jsonify({"error": "missing bearer token"}), 401
    if not hmac.compare_digest(presented, config.TOKEN):
        return jsonify({"error": "invalid token"}), 403

    return None


def register(app) -> None:
    app.before_request(require_token)
    if not config.TOKEN and config.HOST not in ("127.0.0.1", "localhost", "::1"):
        app.logger.warning(
            "Bound to %s with no MATCHER_TOKEN set -- the API is open.", config.HOST
        )
