#!/usr/bin/env python3
"""Check every link in the chain and say which one is broken.

There are a lot of moving parts (pear-desktop, its api-server plugin, matcha,
y-the-md, spice-ify inside Spotify), and a failure anywhere shows up as
"sync doesn't work". This walks the chain in order and reports the first thing
that is actually wrong, with the fix.

    python3 scripts/doctor.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

MATCHA = os.environ.get("MATCHA_URL", "http://127.0.0.1:8080")
PEAR = os.environ.get("YTMD_API_URL", "http://127.0.0.1:26538")

OK, WARN, BAD = "\033[32m  OK \033[0m", "\033[33m WARN\033[0m", "\033[31m FAIL\033[0m"

problems: list[str] = []


def report(status: str, label: str, detail: str = "", fix: str = "") -> None:
    print(f"[{status}] {label}" + (f" — {detail}" if detail else ""))
    if fix:
        print(f"        -> {fix}")
    if status == BAD and fix:
        problems.append(f"{label}: {fix}")


def get(url: str, timeout: float = 3.0) -> tuple[int, dict | None]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            body = r.read()
            try:
                return r.status, json.loads(body)
            except json.JSONDecodeError:
                return r.status, None
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return 0, None


def main() -> int:
    print("\n=== 1. pear-desktop ===")
    running = subprocess.run(
        ["pgrep", "-f", "youtube-music"], capture_output=True
    ).returncode == 0
    report(
        OK if running else BAD,
        "pear-desktop process",
        "running" if running else "not running",
        "" if running else "start the YouTube Music app",
    )

    status, _ = get(f"{PEAR}/api/v1/song")
    if status == 0:
        report(BAD, "api-server plugin", "not reachable",
               "enable it: Plugins -> API Server, and set hostname to 127.0.0.1")
    elif status == 401:
        report(OK, "api-server plugin", "up (401 = needs auth, expected)")
    else:
        report(OK, "api-server plugin", f"up (HTTP {status})")

    print("\n=== 2. matcha ===")
    status, health = get(f"{MATCHA}/api/v1/health")
    if status != 200 or not health:
        report(BAD, "matcha", "not reachable",
               "run: SYNC_ENABLED=0 SYNC_CROSSFADE_MS=6000 python3 -m matcha.main")
        print_summary()
        return 1

    report(OK, "matcha", f"up at {MATCHA}")
    routes = health.get("routes", {})
    spot = routes.get("spotify", {})
    report(
        OK if spot.get("web-api") else WARN,
        "  spotify web-api",
        "credentials present" if spot.get("web-api") else "no credentials (fine — spice-ify covers it)",
    )
    report(
        OK if spot.get("spice-ify") else WARN,
        "  spotify via spice-ify",
        "a Spotify client is connected" if spot.get("spice-ify") else "no Spotify client connected",
    )

    print("\n=== 3. clients checked in ===")
    _, states = get(f"{MATCHA}/api/v1/spotify/state")
    clients = (states or {}).get("clients", {})
    live = {c: s for c, s in clients.items() if not s.get("stale")}

    platforms = {s.get("platform") for s in live.values()}
    for cid, s in live.items():
        report(OK, f"  {cid}", f"platform={s.get('platform')} track={s.get('title')!r}")
    if not live:
        report(BAD, "  (none)", "no client is reporting state",
               "start y-the-md: cd y-the-md && bun run sync")

    report(
        OK if "ytm" in platforms else BAD,
        "  YouTube Music client",
        "present" if "ytm" in platforms else "missing",
        "" if "ytm" in platforms else "cd y-the-md && bun run sync",
    )
    report(
        OK if "spotify" in platforms else BAD,
        "  Spotify client (spice-ify)",
        "present" if "spotify" in platforms else "missing",
        "" if "spotify" in platforms
        else "open Spotify devtools (Ctrl+Shift+I) and look for [spice-ify]; "
             "if nothing, run: spicetify config extensions spice-ify.js && spicetify apply",
    )

    print("\n=== 4. sync engine ===")
    _, sync = get(f"{MATCHA}/api/v1/sync")
    if sync:
        enabled = sync.get("enabled")
        report(
            OK if enabled else WARN,
            "  enabled",
            str(enabled),
            "" if enabled else
            "turn on: curl -X POST -H 'Content-Type: application/json' "
            f"-d '{{\"enabled\":true}}' {MATCHA}/api/v1/sync",
        )
        report(OK, "  leader platform", sync.get("leader_platform", "?"))
        report(
            OK if len(platforms) >= 2 else BAD,
            "  enough clients",
            f"{len(platforms)} platform(s) reporting",
            "" if len(platforms) >= 2
            else "sync needs a leader AND a follower — two platforms, not two processes",
        )
        if sync.get("last_error"):
            report(BAD, "  last error", sync["last_error"])

    print_summary()
    return 1 if problems else 0


def print_summary() -> None:
    print()
    if problems:
        print("\033[31mBlocking problems, in order:\033[0m")
        for i, p in enumerate(problems, 1):
            print(f"  {i}. {p}")
    else:
        print("\033[32mEverything checks out.\033[0m")
    print()


if __name__ == "__main__":
    sys.exit(main())
