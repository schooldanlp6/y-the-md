# Technology stack

A snapshot of what this repo is built from, how the pieces talk to each other, and
where every dependency comes from. Written from the code on 2026-10-29. Where the docs
disagree with the code, the code is what's described here and the gap is listed in
[Known gaps / doc drift](#7-known-gaps--doc-drift).

## 1. Overview

The bridge keeps a **YouTube Music "Music Together" session** and a **Spotify Jam** playing
the same track at roughly the same position (±2–3 s). It is made of **three programs**:

- **`matcha/`** (Python 3.13 + Flask) is the hub. It matches songs across catalogues and
  caches the results in SQLite, relays state and commands between clients, and runs the
  sync engine that decides what each follower should do.
- **`y-the-md/`** (TypeScript on Bun) is the YouTube Music client. It reaches pear-desktop
  through Music Together (PeerJS/WebRTC) and the pear api-server (HTTP), behind a
  capability router.
- **`spice-ify/`** (TypeScript compiled to one JS file) is a Spicetify extension that runs
  inside the Spotify desktop client.

Both clients **poll matcha over plain HTTP at about 1 Hz**. matcha never connects out to a
client: it queues commands, and the clients claim them.

```
                        ┌────────────────────── public internet ───────────────────────┐
                        │  PeerJS broker (0.peerjs.com) · Google STUN · PeerJS TURN    │
                        └───────▲───────────────────────────────────────▲──────────────┘
                                │ signalling + ICE                      │ signalling + ICE
                                │                                       │
 ┌──────────────────────────────┴───────┐   WebRTC data channel  ┌─────┴──────────────────────┐
 │ pear-desktop (YouTube Music 3.12.0)  │◄══════════════════════►│ y-the-md  (Bun)            │
 │  · Music Together plugin  (host)     │  SYNC_PROGRESS/QUEUE,  │  capability router         │
 │  · API Server plugin  :26538 ────────┼──ADD_SONGS, SET_INDEX  │   ├ music-together  (peer) │
 │  · Shortcuts plugin → MPRIS (D-Bus)  │◄───── HTTP + JWT ──────┤   ├ api-server      (HTTP) │
 └──────────────────────────────────────┘    /api/v1/song,queue  │   └ mpris  (declared only, │
            ▲  other Music Together guests                       │            not wired yet)  │
            │  (the shared session)                              └─────────────┬──────────────┘
                                                                               │ HTTP poll ~1 Hz
                                                                               │ /ytm/state, /ytm/pending,
                                                                               │ /ytm/result, /match
                                                                               ▼
                                                     ┌──────────────────────────────────────────┐
                                                     │ matcha  (Python + Flask)  127.0.0.1:8080 │
                                                     │  router → service → logic                │
                                                     │  relay (in-memory) · runner (1 s tick)   │
                                                     │  engine (pure) · store (SQLite cache)    │
                                                     └──┬─────────────────────▲──────────────┬──┘
                         ytmusicapi (HTTPS, unauth.)    │                     │              │ spotipy, client
                       ┌────────────────────────────────┘     HTTP poll ~1 Hz │              │ credentials
                       ▼                                 /spotify/state,      │              ▼ (403 unless the
            music.youtube.com (search)                   /spotify/pending,    │      api.spotify.com  owner
                                                         /spotify/result      │              has Premium)
                                                     ┌─────────────────────────┴────────────────┐
                                                     │ Spotify desktop 1.2.74  + Spicetify      │
                                                     │  spice-ify.js: Spicetify.Player,         │
                                                     │  Platform.PlayerAPI, GraphQL search,     │
                                                     │  CosmosAsync                             │
                                                     └──────────────────────────────────────────┘
```

Things worth knowing from the diagram:

- **Spotify catalogue search goes through the relay by default.** matcha queues a
  `search` request, spice-ify runs it inside the logged-in client (REST `/v1/search` via
  `CosmosAsync` with the user's own session, then GraphQL as a fallback), and posts the
  results back. The Spotify Web API is only a
  fallback and turns itself off after the first owner-Premium 403
  (`matcha/providers/__init__.py:26-92`).
- **No component uses MPRIS or D-Bus yet.** y-the-md declares an `mpris` endpoint in its
  capability tables, but none is constructed (`y-the-md/src/main.ts:47`: "mpris is wired
  next").
- **Music Together is the only path that reaches other YouTube Music listeners.** It
  depends on the public PeerJS broker, which this project doesn't run.

## 2. The programs at a glance

| | **matcha** | **y-the-md** | **spice-ify** | *mt-peer* (debug only) |
|---|---|---|---|---|
| Role | Hub: matching, relay, sync engine | YouTube Music client | Spotify client (in-process extension) | Music Together probe CLI |
| Language / runtime | Python 3.13 (system `python3`), Flask 3.1 | TypeScript, Bun 1.3.5 (no `tsc`) | TypeScript, runs in Spotify's Chromium (CEF) | TypeScript, Bun |
| Entry point | `matcha/main.py` (`create_app()` + `app.run`) | `y-the-md/src/main.ts` (argv mode switch at `:247`) | `spice-ify/src/spice-ify.ts` (`main()` loop at end of file) | `mt-peer/src/main.ts` |
| Runtime deps | flask, rapidfuzz, spotipy, requests (+ ytmusicapi, vendored) | `peerjs`, `node-datachannel` | none (uses the `Spicetify` global) | `peerjs`, `node-datachannel` |
| Run from source | `python3 -m matcha.main` (repo root) | `cd y-the-md && bun run sync` | `cd spice-ify && bun run install-ext`, then `spicetify config extensions spice-ify.js && spicetify apply` | `cd mt-peer && bun run src/main.ts <host-id> [--pause\|--seek N\|--next ID\|--queue-probe ID]` |
| Build | `scripts/build.py` → `dist/matcha` (PyInstaller onefile) | `scripts/build.py` → `bun y-the-md/build.ts` → `dist/y-the-md` (`bun build --compile`) | `bun build src/spice-ify.ts` → `dist/spice-ify.js` | none |
| Listens on | `127.0.0.1:8080` | nothing (outbound only) | nothing (can't open a port) | nothing |

### Single-binary builds (`dist/`)

The build is owned by `scripts/build.py` and `y-the-md/build.ts`, and README.md
([Build](README.md#build), [Requirements](README.md#requirements)) documents it. In brief:

| Artifact | Size | Built with | Links against |
|---|---|---|---|
| `dist/matcha` | ~33 MB | Debian `python3-pyinstaller` 6.13, onefile. Run under `python3 -S` against `/usr/lib/python3/dist-packages` + `vendor/` only, so the stray `/usr/local` pip packages ([§7](#7-known-gaps--doc-drift)) are **not** frozen in. A shim reads `.env` from the CWD and moves the cache to `$XDG_DATA_HOME/matcha/matches.db` (`scripts/build.py:39-60`). | glibc, libz |
| `dist/y-the-md` | ~115 MB | `bun build --compile` plus a plugin that turns node-datachannel's `createRequire` addon load into a static `require`, so `node_datachannel.node` gets embedded (`y-the-md/build.ts`) | glibc |
| `dist/spice-ify.js` | ~7 KB | `bun build` | n/a (loaded by Spicetify) |

`build/` holds intermediates. `dist/` and `build/` are both gitignored.

### Supporting scripts and tests

| File | What it does |
|---|---|
| `scripts/doctor.py` | Walks the chain (pear api-server → matcha → connected clients) and names the first broken link. Stdlib only (`urllib`). Reads `MATCHA_URL`, `YTMD_API_URL`. |
| `scripts/fetch_vendor.py` | Downloads pinned pure-Python wheels from PyPI (`ytmusicapi==1.12.1`), checks their SHA-256, unzips them into `vendor/`, and skips any package the system already provides. |
| `scripts/build.py` | Builds the three artifacts into `dist/` (see above). |
| `tests/` | pytest, 80 tests: `test_logic.py` (scoring), `test_engine.py` (sync decisions), `test_vendor.py` (vendor path). Run with `python3 -m pytest tests/ -q`. No network or credentials needed. |

## 3. matcha internals

### Layering

Requests flow one way only: **`router` → `service` → `logic`/`engine`/`relay`**. Pure
modules never import Flask.

| File | Layer | One-line summary |
|---|---|---|
| `matcha/__init__.py` | bootstrap | Calls `_vendor.activate()` before anything imports a provider client. |
| `matcha/_vendor.py` | bootstrap | **Appends** `<repo>/vendor` to `sys.path`, so apt packages always win over vendored copies. |
| `matcha/main.py` | app | Builds the Flask app, registers the blueprint, CORS and auth, **starts the sync runner thread at import time**, adds JSON 404/500 handlers, runs the Flask dev server. |
| `matcha/config.py` | config | Small `.env` loader (real env wins) and `env()` helper that reads `MATCHA_<X>` with a fallback to the legacy `MATCHER_<X>`. |
| `matcha/auth.py` | middleware | Optional bearer token (`hmac.compare_digest`). Does nothing when no token is set. `/health` and `OPTIONS` are exempt. |
| `matcha/cors.py` | middleware | CORS allowlist (`https://xpui.app.spotify.com`, `https://open.spotify.com`), so spice-ify's preflights pass. |
| `matcha/router.py` | router | HTTP only, one `Blueprint("api", url_prefix="/api/v1")`. Maps `ValueError`→400, `ProviderError`/`ProviderUnavailable`→503. |
| `matcha/service.py` | service | Payload validation. Match cascade (exact cache → ISRC cross-reference → provider search + score). Relay and sync adapters. |
| `matcha/logic.py` | logic (pure) | `Track`/`Score` dataclasses, title/artist normalisation, weighted score (title 0.40, artist 0.35, duration 0.25, accept ≥ 0.75), duration/artist/impostor vetoes. Uses `rapidfuzz`. |
| `matcha/engine.py` | logic (pure) | Sync decisions: `decide`/`plan` (track + seek for each follower), `transport_plan` (play/pause), `EchoGuard`, crossfade `in_guard_window`. Tuning: drift 2.5 s, guard margin 1 s, stale 15 s, echo window 5 s, transition settle 2 s. |
| `matcha/relay.py` | logic (in-memory state) | `Relay`: last `PlaybackState` per client, request queue (`search`/`command`) with platform and target, `wait_for` used by blocking searches. Client timeout 30 s, request TTL 30 s. Lost on restart. |
| `matcha/runner.py` | impure glue | `SyncEngineRunner`, a daemon thread ticking every 1 s. Reads relay states, picks the leader (`SYNC_LEADER`), maps the leader's track through `service.match` (memoised, exponential backoff 15–300 s on failure), runs the engine, and enqueues commands. |
| `matcha/store.py` | persistence | SQLite match cache, one connection per thread. Table `matches` with an ISRC index. Hits are permanent, misses expire after the TTL. |
| `matcha/providers/__init__.py` | providers | Registry (`spotify`, `ytm`). `_SpotifyFacade` tries the spice-ify relay first, then the Web API, and latches the Web API off after an owner-Premium 403. |
| `matcha/providers/base.py` | providers | `Provider` protocol, `ProviderError`, shared `build_query` (title + first artist). |
| `matcha/providers/spotify.py` | providers | spotipy with the client-credentials flow, created lazily. Silences spotipy's ERROR logs. Returns ISRCs. |
| `matcha/providers/spotify_relay.py` | providers | Queues a `search` on the relay and blocks for up to 12 s for spice-ify's answer. |
| `matcha/providers/ytm.py` | providers | Unauthenticated `ytmusicapi.YTMusic()`, created lazily. Parses durations. No ISRC available. |

### HTTP API (`matcha/router.py`)

Every route is under `/api/v1`.

| Method | Path | Line | Used by | Purpose |
|---|---|---|---|---|
| GET | `/health` | `:22` | doctor, y-the-md | Status, provider availability, route detail. No auth required. |
| POST | `/match` | `:27` | y-the-md `--match`, runner | Match one track `{source, target?, track}`. |
| POST | `/match/batch` | `:38` | y-the-md `--match-queue` | Match up to 100 tracks. |
| GET | `/cache` | `:49` | operator | Cache statistics. |
| DELETE | `/cache` | `:155` | operator | Clear the cache. |
| POST | `/spotify/state` | `:59` | spice-ify | Report playback state (~1 Hz). |
| GET | `/spotify/state` | `:67` | doctor, operator | All client states (**both platforms**, despite the path). |
| POST | `/spotify/pending` | `:72` | spice-ify | Claim queued requests (platform defaults to `spotify`). |
| POST | `/spotify/result` | `:82` | spice-ify | Return a search result or command outcome. |
| POST | `/spotify/command` | `:90` | operator | Send a command to a Spotify client by hand. |
| GET | `/spotify/relay` | `:150` | operator | Relay statistics. |
| POST | `/ytm/state` | `:100` | y-the-md | Report playback state (platform forced to `ytm`). |
| POST | `/ytm/pending` | `:111` | y-the-md | Claim queued commands. |
| POST | `/ytm/result` | `:121` | y-the-md | Report a command outcome. |
| GET | `/sync` | `:132` | doctor, operator | Runner status, leader, last actions, config. |
| POST | `/sync` | `:137` | operator | `{"enabled": bool}`, toggles sync live. |
| POST | `/sync/tick` | `:145` | operator | Run one tick on demand and return its actions. |

Command `action`s the engine sends to clients: `play`, `pause`, `next`, `previous`,
`seek`, `playTrack`, `queue`. Both clients handle the same set (`y-the-md/src/sync.ts`,
`spice-ify/src/spice-ify.ts:283-303`).

### Environment variables read by matcha

| Variable | Default | Read at | Notes |
|---|---|---|---|
| `MATCHA_HOST` | `127.0.0.1` | `config.py` | Also accepts legacy `MATCHER_*` for every `MATCHA_*` below. |
| `MATCHA_PORT` | `8080` | `config.py` | |
| `MATCHA_DEBUG` | off | `config.py` | Flask debug mode and DEBUG logging. |
| `MATCHA_TOKEN` | unset | `config.py` → `auth.py` | Bearer token. Unset means no auth. |
| `MATCHA_DB` | `matcha/matches.db` | `config.py` | The frozen build overrides this to `$XDG_DATA_HOME/matcha/matches.db`. |
| `MATCHA_MISS_TTL` | `604800` (7 d) | `config.py` | TTL for cached misses. |
| `MATCHA_SEARCH_LIMIT` | `8` | `config.py` | Candidates per search. |
| `MATCHA_CORS_ORIGINS` | Spotify origins | `cors.py:32` | Comma-separated. `*` is allowed but not the default. |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | unset | `config.py` | Web API client credentials (fallback route only). |
| `SYNC` / `SYNC_ENABLED` | `1` | `runner.py:72` | `0`/`false`/`no`/`off` disables acting. |
| `SYNC_LEADER` | `ytm` | `runner.py:67` | `ytm` or `spotify`. |
| `SYNC_CROSSFADE_MS` | `0` | `runner.py:39` | Crossfade length used for the guard window. |
| `SYNC_DRIFT_TOLERANCE_MS` | `2500` | `runner.py:41` | A single tolerance for all clients. |

`.env` in the repo root is loaded at import (`config.py:load_env_file`). Values already
set in the environment take precedence.

## 4. y-the-md internals

| File | One-line summary |
|---|---|
| `src/main.ts` | CLI and daemon. Builds the endpoints (api-server, music-together), probes, connects, re-probes. Modes: `--sync`, `--status`, `--now`, `--queue`, `--match`, `--match-queue`, and control commands (`--play`, `--pause`, `--skip`, `--back`, `--seek N`, `--play-track ID`, `--enqueue ID`, `--set-index N`). |
| `src/capabilities.ts` | The 7 capabilities (`transport`, `seek`, `position`, `metadata`, `queueRead`, `queueWrite`, `reach`), the 3 endpoint names, the `SUPPORT` matrix, and `DEFAULT_PREFERENCE` with the reason for each choice. |
| `src/config.ts` | Loads `YTMD_*` env vars. Rejects at startup any `YTMD_PREFER_*` override that names an endpoint unable to serve that capability. |
| `src/router.ts` | `Router`: probes availability and resolves capability → endpoint. Defaults fall back to the next endpoint; pinned overrides don't (`NoEndpointError`). |
| `src/endpoints/types.ts` | The `Endpoint` interface (all capability methods optional) and the capability→method map. |
| `src/endpoints/api-server.ts` | pear api-server over HTTP. Gets a JWT via `POST /auth/{clientId}` (at the root, **not** under `/api/v1`), then calls `/api/v1/song`, `/queue`, `/play`, `/seek-to`, and others. |
| `src/endpoints/music-together.ts` | Wraps `MusicTogetherGuest`. Keeps the latest `SYNC_PROGRESS` and queue. Writes with `ADD_SONGS` at `currentIndex+1` and `SET_INDEX`. |
| `src/mt/connection.ts` | Guest-side PeerJS connection: dynamically imports `peerjs` after the WebRTC polyfill, connects to the host id over a reliable data channel, sends `IDENTIFY`, 30 s timeout. |
| `src/mt/protocol.ts` | The Music Together event set, mirrored from pear-desktop **3.12.0** (`TESTED_AGAINST`). Player states. `ICE_SERVERS` (Google STUN, PeerJS TURN, freestun.net TURN). |
| `src/mt/webrtc.ts` | Installs the `node-datachannel/polyfill` WebRTC globals that PeerJS needs outside a browser. |
| `src/matcha.ts` | `MatchaClient`: `GET /health`, `POST /match`, `POST /match/batch`, optional bearer token. Tells "matcha down" apart from "provider down". |
| `src/sync.ts` | `SyncClient`: every ~1 s `POST /ytm/state` (with the capabilities the router can actually resolve) and `POST /ytm/pending`, runs each command through the router, then `POST /ytm/result`. Skips a tick if the previous one is still running. |
| `src/translate.ts` | Converts endpoint shapes to matcha's track format and splits artist credits (`A & B`, `feat.`, `x`, …). |
| `src/hostid.ts` | Resolves `YTMD_MT_HOST_ID`. The value `clipboard` reads it from `wl-paste` / `xclip` / `xsel` and checks it looks like a UUID. |
| `build.ts` | Compile script for `dist/y-the-md` (see §2). |

`src/mt/{connection,protocol,webrtc}.ts` are **byte-identical** to `mt-peer/src/*.ts`.
They are copies, not a shared module, so a protocol fix has to be made in both places.

### Default routing (`src/capabilities.ts:50-58`)

| Capability | Preference (first wins) |
|---|---|
| `reach` | music-together *(only provider)* |
| `transport`, `seek`, `position` | music-together → api-server → mpris |
| `metadata` | api-server → mpris |
| `queueRead`, `queueWrite` | api-server → music-together |

Without `YTMD_MT_HOST_ID` the music-together endpoint is unavailable and everything goes
to api-server, so only this machine is affected. With a host id, transport and seek
reach the whole session.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MATCHA_URL` | `http://127.0.0.1:8080` | Where matcha is. |
| `MATCHA_TOKEN` | unset | Bearer token for matcha. |
| `YTMD_CLIENT_ID` | `y-the-md-<random>` | Relay client id. |
| `YTMD_MT_HOST_ID` | unset | Music Together host peer id, or `clipboard`. |
| `YTMD_API_URL` | `http://127.0.0.1:26538` | pear api-server base URL. |
| `YTMD_API_TOKEN` | unset | Pre-issued api-server JWT (skips `/auth`). |
| `YTMD_API_CLIENT_ID` | `ytm-bridge` | Client id used for api-server auth. |
| `YTMD_MPRIS_IDENTITY` | `YouTube Music` | MPRIS identity to look for (read, but there's no MPRIS endpoint yet). |
| `YTMD_PREFER_<CAPABILITY>` | defaults above | Ordered endpoint list. Pinning disables fallback. |
| `YTMD_DISABLE` | empty | Comma-separated endpoints to switch off. |

## 5. spice-ify

One file, `spice-ify/src/spice-ify.ts` (371 lines). It runs inside Spotify's xpui page
(origin `https://xpui.app.spotify.com`), which is why matcha has CORS.

**Spicetify APIs used**

| API | For |
|---|---|
| `Spicetify.Player.data`, `.getProgress()`, `.isPlaying()` | Reading the current track, position and paused state. Artists come from `artist_name`, `artist_name:1..7`. |
| `Spicetify.Player.play/pause/next/back/seek` | Transport and seek commands. |
| `Spicetify.Platform.PlayerAPI.addToQueue`, `.play` | `queue` and `playTrack` commands. |
| `Spicetify.CosmosAsync.get` | **Primary search route**: `GET https://api.spotify.com/v1/search` signed with the user's own client session, not matcha's dev app (`restSearch`, ~`:135`). |
| `Spicetify.GraphQL.Request(Definitions[...])` | Fallback search: tries `searchModalResults`, then `searchDesktop`, then `searchTracks`, whichever exists (`graphqlSearch`). |

**Talking to matcha:** two `setInterval` loops at 1000 ms. `pushState` sends
`POST /spotify/state {client_id, state}`, and `pollWork` sends `POST /spotify/pending`,
runs each request, and replies with `POST /spotify/result`. At startup it waits until
`Spicetify.Player.data` and `CosmosAsync` exist. Console messages are prefixed
`[spice-ify]`.

**Hardcoded values:** `MATCHA_URL = 'http://127.0.0.1:8080'` and a random
`spice-ify-xxxxxx` client id. There is no token support and no way to change these at
runtime (see §7).

## 6. Dependency provenance

✅ = Debian-packaged and installed from the Debian archive. ⚠️ = **not** from Debian.

| Dependency | Version on this machine | Used by | Source | Debian? |
|---|---|---|---|---|
| Debian 13 "trixie", glibc | 2.41 | everything | OS | ✅ |
| `python3` | 3.13.5 | matcha, scripts, tests | apt | ✅ |
| `python3-flask` | 3.1.1-1 | matcha | apt | ✅ |
| `python3-rapidfuzz` | 3.12.2+ds-1 | `matcha/logic.py` | apt | ✅ |
| `python3-spotipy` | 2.25.1-1 | `matcha/providers/spotify.py` | apt | ✅ |
| `python3-requests` | 2.32.3+dfsg-5 | ytmusicapi, spotipy | apt (**shadowed**, see §7) | ✅ |
| `python3-urllib3` | 2.3.0-3 | requests | apt (**shadowed**, see §7) | ✅ |
| `python3-certifi` | 2025.1.31+ds-1 | requests | apt. Debian's copy points at `/etc/ssl/certs/ca-certificates.crt` | ✅ |
| `python3-pytest` | 8.3.5-2 | tests | apt | ✅ |
| `python3-pyinstaller` | 6.13.0+ds-2 | `scripts/build.py` | apt | ✅ |
| `python3-dasbus` | 1.7-2 | **nothing yet** (documented for MPRIS) | apt | ✅ |
| `ytmusicapi` | 1.12.1 (pinned in `fetch_vendor.py`) | `matcha/providers/ytm.py` | ⚠️ PyPI wheel unpacked into `vendor/` (pure Python, `py3-none-any`) | ⚠️ no |
| Bun | 1.3.5 | y-the-md, spice-ify build, mt-peer | ⚠️ standalone binary at `~/AppImages/bin/bun` | ⚠️ no |
| Node.js | 26.3.0 | not needed by any program (Bun is used) | ⚠️ standalone at `~/AppImages/bin/node` | ⚠️ no |
| `peerjs` | ^1.5.4 (1.5.5 installed) | y-the-md, mt-peer | ⚠️ npm | ⚠️ no |
| `node-datachannel` | ^0.27.0 (0.27.0 installed) | y-the-md, mt-peer | ⚠️ npm, **native N-API addon** (prebuilt `node_datachannel.node` via `prebuild-install`) | ⚠️ no |
| pear-desktop (`youtube-music`) | 3.12.0 | YouTube Music player, Music Together host, api-server | ⚠️ `.deb` from GitHub releases (dpkg-installed, not from the archive) | ⚠️ no |
| Spotify desktop (`spotify-client`) | 1:1.2.74.477 | Spotify player | ⚠️ Spotify's own apt repo | ⚠️ no |
| Spicetify CLI | not on PATH | loads spice-ify | ⚠️ upstream install script | ⚠️ no |
| `wl-clipboard` / `xclip` / `xsel` | optional | `YTMD_MT_HOST_ID=clipboard` | apt | ✅ |
| PeerJS broker, Google STUN, PeerJS TURN, freestun.net TURN | n/a | Music Together signalling/ICE | ⚠️ external public services | n/a |
| Spotify Web API | n/a | fallback search | ⚠️ external, needs owner Premium | n/a |
| music.youtube.com | n/a | ytmusicapi search | ⚠️ external, unofficial API | n/a |

## 7. Known gaps / doc drift

Reported here only. Nothing was changed.

**Architecture docs vs. code**

1. **AGENTS.md describes a different layout.** It lists four or five deployables:
   `matcha/` as matching only, `relay/` and `agent/` as "not yet built", and
   `spicetify-ext/` as optional. In the code (and per the user) matcha *is* the relay
   and sync hub (`relay.py`, `engine.py`, `runner.py`), there is no `agent/`, and the
   Spotify client is `spice-ify/`. The AGENTS.md "Authorization" section still calls
   matcha stateless with one caller. It now holds live session state and has two or
   more client types.
2. **The AGENTS.md defaults are reversed.** AGENTS.md says the default Spotify route is
   `mpris` + `spotify-web-api` and that "no feature may be built such that it only works
   when Spicetify is present." In the code, Spotify state, transport, seek, queue and
   (by default) search **only** go through spice-ify. There's no MPRIS or Web API
   *client* for Spotify, and the Web API is only a search fallback inside matcha.
3. **MPRIS isn't implemented anywhere.** y-the-md declares `mpris` in `SUPPORT` and
   `DEFAULT_PREFERENCE` but never constructs it (`src/main.ts:47`). `python3-dasbus` is
   installed and documented but nothing imports it.
4. **The crossfade handshake doesn't exist.** DEPENDENCIES.md Part 6 and `.env.example`
   document `SYNC_CROSSFADE_STRICT` and say clients report their crossfade for the server
   to compare. Nothing reads `SYNC_CROSSFADE_STRICT`, and neither client reports
   crossfade. Only `SYNC_CROSSFADE_MS` is used, and only for the guard window.
5. **There's one drift tolerance for everyone.** AGENTS.md says "tolerances are per-tier".
   `runner.py` applies one `SYNC_DRIFT_TOLERANCE_MS` to every client. Also,
   `PLATFORM_CAPABILITIES` (`runner.py:31`) gives both platforms
   `seek, transport, queue`, so a client that reports no capabilities is treated as
   fully capable.
6. **TODO.md is stale in places.** It says the "Sync state machine … [is] entirely
   unbuilt", but `engine.py` and `runner.py` implement it, with 80 tests. It still refers
   to `server/` and "the agent".

**Configuration and docs**

7. **`.env.example` says the wrong thing about Premium.** It says Spotify client
   credentials need "no Premium". AGENTS.md constraint 3 and DEPENDENCIES.md Part 7 say
   the owner *does* need Premium, and that was verified with a 403.
8. **spice-ify can't follow a cloud-hosted matcha.** `MATCHA_URL` is hardcoded to
   `http://127.0.0.1:8080` and no `Authorization` header is sent
   (`spice-ify/src/spice-ify.ts:23,36`). The CORS allowlist is in place, but setting
   `MATCHA_TOKEN` (needed off-box, per `auth.py`) would lock spice-ify out. Running
   matcha remotely needs a rebuild plus token support. The same applies to Spotify's CSP
   allowing a non-loopback origin, which TODO.md lists as unproven.
9. **The auth log names the old variable.** `auth.py` messages mention `MATCHER_TOKEN`.
   The preferred name is `MATCHA_TOKEN`, and both work (`config.env`).
10. **DEPENDENCIES.md is out of date on several points.** It says `bun install` is only
    for `mt-peer/` and that "there is no build step". y-the-md also needs the packages,
    and `scripts/build.py` / `y-the-md/build.ts` now exist. It calls node/npm "already
    installed" as if they were system packages, but they're standalone binaries in
    `~/AppImages/bin`, and no program needs Node. Its undo instructions mention
    `vendor/ytmusicapi-*.dist-info`, but `vendor/` holds no dist-info, so
    `ytmusicapi.__version__` is undefined at runtime and the 1.12.1 version can only be
    confirmed from the pin in `fetch_vendor.py`.

11. **The docs name the wrong primary search.** matcha's docstrings
    (`providers/__init__.py`, `providers/spotify_relay.py`) say spice-ify uses the
    internal GraphQL `searchModalResults` query. spice-ify actually tries REST
    `/v1/search` through `CosmosAsync` first and only falls back to GraphQL
    (`handleSearch`, order `['rest', 'graphql']`). That REST call still goes to
    `api.spotify.com`, using the user's own token, so the "don't hammer Spotify search"
    rate-limit concern applies to it.

**Repo setup**

12. **`y-the-md/node_modules` is a committed symlink to `../mt-peer/node_modules`.**
    y-the-md has no lockfile of its own; it relies on `mt-peer/bun.lock`. `.gitignore`
    lists `bun.lockb` (the old binary format), while the repo uses text `bun.lock`.
    `build.ts`'s error message ("run `bun install` in y-the-md/") would install through
    the symlink into mt-peer's tree.

**This machine**

13. **pip packages in `/usr/local` shadow Debian's HTTP stack.** `sys.path` is
    `… ~/.local/lib/python3.13/site-packages`, `/usr/local/lib/python3.13/dist-packages`,
    then `/usr/lib/python3/dist-packages`. `/usr/local` holds a root-owned pip install of
    requests 2.32.4, **urllib3 1.26.20** (Debian ships 2.3.0), certifi, idna and
    charset_normalizer (plus PyQt6, matrix_client, vboxapi). So `python3 -m matcha.main`
    from source uses those copies for ytmusicapi and spotipy, including pip's bundled CA
    file instead of `/etc/ssl/certs`. This project didn't install them and they should
    stay. The frozen `dist/matcha` avoids them (`-S` + explicit paths); the source run
    doesn't.
14. **The Spotify side probably isn't loaded.** The `spicetify` binary isn't on PATH.
    `~/.config/spicetify/config-xpui.ini` exists, but `spice-ify.js` isn't in its
    extensions list or in `~/.config/spicetify/Extensions`. `bun run install-ext` copies
    to `~/.spicetify/Extensions`, which doesn't exist; this Spicetify install's
    extensions folder is `~/.config/spicetify/Extensions`. That folder is **empty**, even
    though `config-xpui.ini` lists five extensions (`yt-music-jam-api.js`,
    `fullAppDisplay.js`, `webnowplaying.js`, `popupLyrics.js`, `trashbin.js`).
    `yt-music-jam-api.js` looks like an older name for this project's extension. Until this is fixed, no
    Spotify client reports to matcha and the sync engine has no follower.

**Runtime limits**

15. **matcha runs on Flask's development server** (`app.run`, threaded) with the relay
    in process memory. It can't run more than one worker, and a restart drops every
    client's state until the next poll (TODO.md "Session state"). The sync thread also
    starts as a side effect of `import matcha.main` (`main.py:21`, `app = create_app()`
    at module level).
16. **Everything polls.** Both clients make two HTTP requests per second each, and a
    Spotify search blocks a matcha worker thread for up to 12 s while it waits on the
    relay. TODO.md lists WebSocket as the intended replacement.
