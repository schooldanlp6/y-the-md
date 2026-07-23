"""CORS, scoped to the origins that actually need it.

spice-ify runs inside the Spotify client, whose pages are served from
`https://xpui.app.spotify.com`. Any request it makes to matcha is cross-origin,
and because we send `Content-Type: application/json` the browser sends a
preflight `OPTIONS` first. Without these headers the preflight fails and the
extension can never reach matcha.

**Why not `*`:** matcha binds 127.0.0.1, but "local" is not the same as "safe" in
a browser. With a wildcard, *any* page the user has open could POST to
127.0.0.1:8080 and drive their playback, read what they are listening to, or
enqueue tracks. An allowlist costs nothing and closes that.
"""
from __future__ import annotations

import os

from flask import request

#: Origins allowed by default. Both are Spotify's own.
DEFAULT_ORIGINS = (
    "https://xpui.app.spotify.com",
    "https://open.spotify.com",
)


def allowed_origins() -> tuple[str, ...]:
    """Allowlist, overridable via `MATCHA_CORS_ORIGINS` (comma-separated).

    Setting it to `*` is honoured but deliberately not the default -- see above.
    """
    raw = os.environ.get("MATCHA_CORS_ORIGINS", "").strip()
    if not raw:
        return DEFAULT_ORIGINS
    return tuple(o.strip() for o in raw.split(",") if o.strip())


def register(app) -> None:
    @app.after_request
    def add_cors_headers(response):
        origin = request.headers.get("Origin")
        if not origin:
            return response

        allowed = allowed_origins()
        if "*" in allowed:
            response.headers["Access-Control-Allow-Origin"] = "*"
        elif origin in allowed:
            response.headers["Access-Control-Allow-Origin"] = origin
            # Caches must not serve one origin's response to another.
            response.headers["Vary"] = "Origin"
        else:
            return response

        response.headers["Access-Control-Allow-Methods"] = (
            "GET, POST, PATCH, DELETE, OPTIONS"
        )
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response.headers["Access-Control-Max-Age"] = "600"
        return response
