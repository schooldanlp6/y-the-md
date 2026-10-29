# AGENTS.md

Instructions for Claude working in this repo. Read this before changing code.

## What this project is

A bridge that keeps a **YouTube Music "Music Together" session** and a **Spotify Jam**
playing the same thing at roughly the same time.

### Deployables — three

**A hook is not a build.** Ways of reaching a player are modules inside a client, not
separate programs. Counting hooks as deployables is how this turns into five or six projects
that don't need to exist.

| # | Build | Language | Role |
|---|---|---|---|
| 1 | `matcha/` | Python + Flask | **The central hub.** Song matching, plus the relay (live session state, per-client work queues) and the sync engine that decides what every client does. **Stateful:** session state in memory, matches cached in SQLite. Everything under `/api/v1`. |
| 2 | `y-the-md/` | TypeScript + Bun | **The YouTube Music client**, on the host's machine. Hooks into pear-desktop (api-server, Music Together) behind one capability router; reports to matcha and runs its commands. |
| 3 | `spice-ify/` | TypeScript, Spicetify extension | **The Spotify client**, one per Spotify listener, inside their Spotify desktop. Reports state, runs commands and catalogue searches, forwards queue adds; talks only to matcha. |

Built with `python3 scripts/build.py` into `dist/`: two self-contained executables plus one JS
file (see README.md).

**Session state lives in the host and in matcha.** The host's YouTube Music now-playing and
queue *are* the session; matcha holds who is connected and the work in flight. YouTube Music
listeners join the host through Listen Together (Music Together) and need nothing from
matcha. Every Spotify listener needs matcha.

The original plan had two more builds, a `relay/` and a per-Spotify-listener `agent/`, with
the Spicetify extension as an optional booster *feeding* that agent. Both were folded in, so
don't recreate them:

- **The relay is part of matcha**: `relay.py`, `engine.py` and `runner.py`, plus the
  `/spotify/*`, `/ytm/*`, `/queue/*` and `/sync` routes.
- **spice-ify does the agent's job itself**, namely local player control and the link to the
  hub, because it already runs inside Spotify.

`mt-peer/` is not a deployable — it is the protocol spike and live-probe CLI
(`--pause`, `--seek`, `--next`, `--queue-probe`). Keep it for testing against a real
session; the production Music Together code lives in `y-the-md/src/mt/`.

The topology is **asymmetric, and that is correct**: Music Together is already a shared
session we can join once, whereas Spotify Jam is closed to us, so Spotify needs presence on
each participant's machine (spice-ify). Don't try to force symmetry.

### Capability routing (both clients)

Clients never name a hook directly — they ask for a **capability** and a router picks the
endpoint. Implemented in `y-the-md/src/{capabilities,router,config}.ts`. spice-ify has a
single hook today (Spicetify), so it has no router yet; a second Spotify hook must follow the
same shape.

- **Where a capability is genuinely redundant, any provider may be chosen explicitly.**
- **Where one provider is better, it is the default preference** — with a documented reason.
- **Every default is overridable** via `YTMD_PREFER_<CAPABILITY>=endpoint[,endpoint]`, plus
  `YTMD_DISABLE=endpoint` to switch one off entirely.

Two rules the router enforces, both deliberate:

1. **An override that cannot work is rejected at startup**, naming the capable endpoints —
   never silently ignored, which would look like the override had no effect.
2. **A pinned capability does not fall back.** Defaults fall back freely (that is the point
   of three hooks); an explicit pin fails loudly instead of quietly using something else.

The hooks are **modules inside a client, not programs**:

| Hook | Platform | Lives in | Needs | Status |
|---|---|---|---|---|
| `pear-api-server` | YT Music | y-the-md | pear-desktop, api-server plugin on. Local only, but the **only** source of track *metadata* and upcoming tracks — see constraint 9 | built; default for queue and metadata |
| `music-together` | YT Music | y-the-md | the host's peer id | built; the only hook that reaches other listeners |
| `mpris` | either | y-the-md (listed) | nothing — D-Bus, local. **Transport only** (constraint 10) | not wired yet |
| `spicetify` | Spotify | spice-ify | Spicetify + our extension | built; **today the only Spotify client** |
| `spotify-web-api` | Spotify | matcha `providers/spotify.py` | client ID + owner Premium (+ OAuth + per-user Premium for player control) | catalogue search only |

**Spotify must always be fully usable without Spicetify.** `mpris` + `spotify-web-api`
together are the native route and they are the *default*: MPRIS supplies transport and seek,
the Web API supplies queue and state. Spicetify is an upgrade layered on top, never a
requirement — no feature may be built such that it only works when Spicetify is present. A
participant running plain Spotify and one running Spicetify must both work in the same
session, and the difference must be capability, never participation.

> **Status (2026-10-29): not met.** spice-ify is the only Spotify client; the MPRIS + Web
> API route was planned for the per-listener `agent/` and never built, so a Spotify listener
> without Spicetify cannot take part yet. Whether this rule stays a goal or is dropped is
> **an open decision for the user** — ask before building either way.

Each client probes what's actually present on its machine, selects hooks accordingly, and
reports the resulting capability set to matcha. (y-the-md does; spice-ify does not report
capabilities yet, so matcha assumes the Spotify platform default.)

Externally required, not built by us: **pear-desktop** with the Music Together plugin
(that's the session `mt-peer` joins). The api-server plugin is optional — see
`DEPENDENCIES.md` Part 4.

Read `TODO.md` for what is planned and why. Adding a client integration is not a rewrite —
see Capability tiers below.

## Hard constraints — do not re-litigate these

These were researched and settled. They shape everything; changing them means redesigning.

1. **Spotify Jam has no API.** Not in the Web API, not in librespot
   ([librespot#1576](https://github.com/librespot-org/librespot/issues/1576)). There is no
   endpoint to create a Jam, fetch its link, list participants, or end it.

2. **We read a Jam by being in it.** The bridge's Spotify account joins the Jam manually as a
   normal participant. Then `GET /me/player/currently-playing` reflects Jam state and
   `POST /me/player/queue` appends to the Jam queue. That is the entire available surface.

3. **Spotify quota forces the single-account design** *(Web API tier only)*. Since
   2026-03-09, dev mode allows **5 authenticated users, one Client ID per developer**.
   Extended quota needs a registered business with 250k MAU — unreachable here. So on this
   tier: **exactly one Spotify account (the bridge's) ever authorizes our app.** Any design
   that asks each listener to OAuth is dead on arrival.

   **The app owner must have Premium for *any* Web API call, including client-credentials
   catalogue search.** Confirmed empirically: a non-Premium owner gets `403 Active premium
   subscription required for the owner of the app` on plain `/v1/search`, with no user in
   the picture. Do not assume search is exempt from the dev-mode restrictions — it isn't.
   If the owner account is not Premium, **the Spotify Web API is entirely unavailable** and
   ytm→spotify matching needs another route (see TODO.md).

4. **Either platform can lead; YouTube Music is the default.** MPRIS can seek both players,
   so leadership is a runtime setting, not an architectural fact. **Never hardcode a sync
   direction** — the engine reads which participant is leader from config and must work
   with it pointing either way. The only genuine restriction: a participant reachable *only*
   via the Spotify Web API cannot be seeked, so it can follow loosely but can never lead.

   YTM-as-leader has a cost worth knowing: it makes **ytm→spotify** the hot matching path,
   and that direction needs Spotify catalogue search, which needs Web API access (see
   constraint 3). Spotify-as-leader needs no Spotify API at all.

5. **Queue sync is bidirectional, and it is the expensive requirement.** MPRIS cannot queue
   on either player (neither implements `TrackList` — verified), so queue writes always go
   through a platform-specific route:

   | Side | Route | Requires |
   |---|---|---|
   | YouTube Music | **Music Together `ADD_SONGS`** *(verified working)* | nothing but the host id — reaches the whole session |
   | YouTube Music | pear api-server `POST /queue` | plugin enabled; local only, but supports `insertPosition` |
   | Spotify | Web API `POST /me/player/queue` | **Premium per end user** + `user-modify-playback-state` + an OAuth slot (5 max) |
   | Spotify | Spicetify `addToQueue` | Spicetify installed; no dev app, no OAuth slot |

   Note the asymmetry: **the YouTube Music side needs no credentials at all**, while every
   Spotify route costs either Premium or an install. Queue sync will therefore often be
   YTM → Spotify only, and that is an acceptable shipping state.

   **Web API queue writes require the end user to hold Premium** — not just the app owner.
   A free-tier Spotify participant can still take part via MPRIS (read, seek, transport)
   but cannot have their queue written through the Web API. Degrade to that rather than
   excluding them.

   Spotify also warns that ordering is not guaranteed when queue calls are mixed with other
   Player API calls. **Never issue a queue write and a seek concurrently to the same
   client** — serialize them and confirm state after.

6. **Sync target is ±2–3 seconds, not lockstep.** Music Together tolerates 3s drift; Spotify
   Web API polling is ~1s at best and seeks land 200–500ms late. Sub-second cross-platform
   sync is not achievable. Don't add complexity chasing it.

7. **We join Music Together as a real peer.** *(Reverses an earlier decision — the protocol
   turned out to be plain PeerJS with a clean message set, so this is glue, not a rewrite.)*

   Music Together is P2P WebRTC over PeerJS, host/guest, using the public PeerJS broker plus
   Google STUN and PeerJS TURN. A guest joins with nothing but the host's peer id
   (`peer.connect(id)`). The message set from `connection.ts` is complete enough to
   participate fully:

   | Event | Payload | Gives us |
   |---|---|---|
   | `SYNC_QUEUE` | `{ videoList }` | full queue state |
   | `ADD_SONGS` | `{ videoList, index? }` | **queue write** |
   | `REMOVE_SONG` / `SET_INDEX` | `{ index }` | queue edit, track select |
   | `MOVE_SONG` | `{ fromIndex, toIndex }` | reorder |
   | `CLEAR_QUEUE` | `null` | reset |
   | `SYNC_PROGRESS` | `{ progress?, state?, index? }` | position + play state |
   | `IDENTIFY` / `SYNC_PROFILE` | `Profile` | participant roster |
   | `PERMISSION` | `Permission` | whether guests may write |

   **Verified live against pear-desktop 3.12.0 on 2026-07-21** (Bun + `peerjs` +
   `node-datachannel`), not merely inferred from source:

   | Capability | Verified | How |
   |---|:--:|---|
   | Join as a non-pear-desktop peer | ✅ | host's raw PeerJS id is the *entire* credential — no account, no token |
   | Read position / play state | ✅ | `SYNC_PROGRESS` at 1 Hz: `{ progress: float seconds, state, index }` |
   | Pause / resume | ✅ | echo `SYNC_PROGRESS` with `state: 2` / `1`; took effect <1s and held |
   | Seek | ✅ | echo `SYNC_PROGRESS` with a new `progress`; host jumped 44.7s → 30.1s and continued |
   | **Queue write** | ✅ | `ADD_SONGS` accepted and **echoed back to all peers** |
   | **Queue read (full snapshot)** | ✅ | `SYNC_QUEUE` with the entire list (57 tracks observed) |
   | Queue edits by others | ✅ | `MOVE_SONG {fromIndex, toIndex}` observed live |

   `state` values are YouTube IFrame player states (`1` playing, `2` paused).

   **`SYNC_QUEUE` is event-driven, never sent on join.** It fires on:
   1. **track change** — measured at 91ms after the index advanced, and
   2. **queue mutation** — arrived ~4s after our own `ADD_SONGS`.

   So a joining peer sees no queue at all until one of those happens. Wait for it rather
   than requesting it; there is no request verb. The api-server `/api/v1/queue` endpoint
   would give an instant snapshot but is **not required** — worth using only to avoid a
   wait of up to one song.

   **Queue writes do reach the real player — but only at a reachable index.**

   Measured across three attempts:

   | Attempt | Result |
   |---|---|
   | `ADD_SONGS` with no `index` (append) | echoed, `SYNC_QUEUE` grew — but **never appeared and never played** |
   | `ADD_SONGS` with `index: currentIndex + 1` | landed in the real queue; appeared once playback reached it |
   | `SET_INDEX` to that slot | **honoured** — index moved 1 → 2, stayed, and the track played |

   The append failure was positional, not semantic: with autoplay / infinite playback on,
   the queue has no reachable end, so an appended track sits past the horizon forever. It
   is *not* that the session queue is decorative — it does drive the player.

   **Never append. Always insert at `currentIndex + 1`** (from the latest `SYNC_PROGRESS`),
   and use `SET_INDEX` when a track must play immediately rather than eventually.

   Note the UI only shows the inserted track once playback reaches it, so "it didn't appear"
   is not evidence of failure. Confirm with `SYNC_QUEUE` length plus `SET_INDEX`, not by
   looking at the queue pane.

8. **"Now playing" is the contract; queue sync is the optimisation.** The engine's
    guarantee is **"the leader is playing track X at position P — make that true here
    too"**, expressed as an explicit track selection plus a seek. That works on every tier,
    including ones that cannot queue at all (MPRIS).

    Queue sync is real and worth doing — YouTube Music supports it fully (constraint 7) —
    but it is an *optimisation on top*, not the mechanism. It buys pre-matching: knowing
    the next few tracks lets the matcha resolve them before they are needed instead of
    scrambling at the transition.

    Never let core sync depend on queue writes succeeding. Spotify's `POST /me/player/queue`
    appends after an undefined pending set and needs Premium per user, so it will not always
    be available even when the YTM side is fully capable.

   **No `PERMISSION` event is ever sent to a joining guest**, yet every write above
   succeeded. Do not gate writes on `PERMISSION` — it stays `undefined`, and gating on it
   blocks everything forever.

   Consequences that shape the design:

   - **This covers the whole YouTube Music side, including queue.** But it is not the only
     hook — see the api-server surface below, which is complementary and in places better.
   - **The YTM side is one shared connection, not one per participant.** Music Together is
     already a shared session, so a single peer serves every YT Music listener. Only the
     Spotify side needs per-participant presence, because Jam is closed to us.
   - Node needs a native WebRTC module (`peerjs` alone is not enough) — this is the one
     place the project takes a non-pure-JS dependency.
   - The protocol is plugin-internal and may shift between pear-desktop releases. Pin the
     tested version and fail loudly on unknown event types rather than guessing.

9. **The pear api-server is a full control surface, not just player controls.** It is the
    second hook into pear-desktop and complements Music Together rather than duplicating it.
    Routes (all under `/api/v1`, port 26538, ships **disabled**):

    | Area | Endpoints |
    |---|---|
    | Queue read | `GET /queue`, `GET /queue/next` (upcoming track) |
    | Queue write | `POST /queue {videoId, insertPosition}`, `PATCH /queue/{index} {toIndex}`, `DELETE /queue/{index}`, `PATCH /queue {index}`, `DELETE /queue` |
    | **Current song** | `GET /song` — **full metadata**, not just an id |
    | **Search** | `POST /search {query, params, continuation}` |
    | Transport | `POST /play`, `/pause`, `/toggle-play`, `/next`, `/previous` |
    | Seek | `POST /seek-to {seconds}`, `/go-back`, `/go-forward` |
    | Modes | `GET,POST /shuffle`, `GET /repeat-mode`, `POST /switch-repeat` |
    | Volume | `GET,POST /volume`, `POST /toggle-mute` |
    | Ratings | `GET /like-state`, `POST /like`, `POST /dislike` |

    Two things it gives us that Music Together cannot:

    - **Track metadata.** Music Together only ever carries `{videoId, ownerId}`, so every
      title/artist/duration needs a lookup. `GET /song` returns it directly.
    - **Search inside the user's own authenticated client** (`POST /search`), which is an
      alternative to ytmusicapi and needs no separate credentials.

    Its limit is that it is **local-only** — it controls the pear-desktop on that machine,
    not the shared session. So: **api-server for rich local read/write, Music Together for
    the shared session and for reaching everyone else.**

    ### Redundancy across the three YouTube Music hooks

    Three hooks (Music Together, api-server, MPRIS) give real fallback depth on most
    capabilities — but not on all, and the gap matters:

    | Capability | MT | api-server | MPRIS | Depth |
    |---|:--:|:--:|:--:|---|
    | Transport (play/pause/next) | ✅ | ✅ | ✅ | **3** |
    | Seek | ✅ | ✅ | ✅ | **3** |
    | Position + play state | ✅ | ✅ | ✅ | **3** |
    | Track metadata | ✗ *(videoId only)* | ✅ | ✅ | 2 |
    | Queue read / write | ✅ | ✅ | ✗ | 2 |
    | Upcoming track | ✅ | ✅ | ✗ | 2 |
    | **Reaching other listeners** | ✅ | ✗ | ✗ | **1 — single point of failure** |

    **Music Together is the only hook that reaches anyone else**, and it depends on the
    public PeerJS broker, which we neither run nor can replace without patching
    pear-desktop. Everything else has a fallback; this does not. Treat broker
    unavailability as a real failure mode and surface it clearly rather than retrying
    silently.

    Preference order when more than one hook can serve a request:
    **Music Together → api-server → MPRIS.** Prefer the widest reach first, then the
    richest local data, then the lowest common denominator.

10. **MPRIS is for transport, not for truth.** Use it for skip / stop / pause / seek and as a
   fallback state source only. Authoritative state comes from Music Together on the YT Music
   side and from Spicetify or the Web API on the Spotify side. Do not build the sync engine's
   state model on MPRIS metadata — it is lowest-common-denominator and lacks queue entirely.

11. **Crossfade must be identical on every client, and is set once in the server env**
   (`SYNC_CROSSFADE_MS`). Mismatched crossfade makes track boundaries diverge by the
   difference at *every* transition, and it accumulates — it presents as a worsening drift
   bug, not as an error. Agents read their local value from disk and report it at handshake;
   the server compares. Beyond equality the engine needs exactly one extra rule: **no seeks
   inside the guard window** around a track boundary (`duration − C − margin` through
   `C + margin`), because MPRIS position is ambiguous mid-fade and seeking there aborts the
   fade audibly on that client alone. No crossfade modelling beyond that.
   See `DEPENDENCIES.md` Part 6.

## Capability tiers

There is more than one way to reach a listener, and they are not equally good. **Both
Spotify paths ship — nobody is excluded for not running Spicetify, and nobody running it is
held back to the weakest path.**

| Tier | Platform | `read` | `seek` | `transport` | `append` | Reach |
|---|---|:--:|:--:|:--:|:--:|---|
| Web API | Spotify | ✅ | ✗ | ✗ | ✅ | anyone, incl. mobile; nothing to install |
| **MPRIS** | **either** | ✅ | ✅ | ✅ | ✗ | local Linux desktop only |
| pear api-server | YT Music | ✅ | ✅ | ✅ | ✅ | pear-desktop, plugin enabled |
| Spicetify ext | Spotify | ✅ | ✅ | ✅ | ✅ | desktop Spicetify users |

**MPRIS numbers above are measured, not assumed** (2026-07-21, this machine):
`org.mpris.MediaPlayer2.YoutubeMusic` and `org.mpris.MediaPlayer2.spotify` both report
`CanControl=true`, `CanSeek=true`, `CanPlay/CanPause=true`. **Neither implements the
`TrackList` interface**, so MPRIS gives no queue access on either player. YouTube Music
additionally reports `CanGoPrevious=false`.

Two consequences that drive the design:

- **MPRIS and the Web API are complementary, not redundant.** Their capability sets are
  near-inverses: MPRIS seeks but cannot queue; the Web API queues but cannot seek. For
  Spotify, using both together beats either alone.
- **MPRIS is machine-local.** It rides the session D-Bus, so it can only reach players on
  the same box as the process using it. It is not a way to control a remote participant.

Rules that follow from this, and that new code must respect:

Rules that follow from this, and that new code must respect:

- **Adapters declare capabilities; they don't get special-cased.** An adapter advertises some
  subset of `read` / `append` / `seek` / `transport`. The sync engine branches on the
  declared capability, never on the adapter's name or platform. Adding a third tier later
  must not mean editing the engine.
- **Drive each participant to the best of *its own* ability — never lowest-common-denominator.**
  A Spicetify listener gets seeked into tight sync in the same session where a Web API
  listener merely gets the queue appended and drifts within tolerance. Degrading everyone to
  the weakest participant defeats the point of building the better tier.
- **Never assume `seek` exists.** Every seek is conditional on the capability being declared;
  the fallback is always "queue it and accept drift."
- **Tolerances are per-tier.** ±2–3s (constraint 6) is the Web API tier's target. The
  Spicetify and pear-desktop tiers can hold much tighter. Don't hardcode one global drift
  constant.

Build the adapter interface *before* the second adapter exists. Retrofitting tiers onto a
hardcoded single adapter is the expensive way to arrive at the same place.

## API conventions

- **Every HTTP route is under `/api/v1`.** No exceptions, including `/health`. The version
  prefix lives in the blueprint's `url_prefix`, never hand-written per route.
- JSON in, JSON out. Errors are `{"error": "<message>"}` with a real status code.
- Route functions never contain business logic. See layering below.

## Layering (from the project's Flask template)

Strict, one direction only: **`router` → `service` → `logic`**

- **`router.py`** — HTTP only. Read the request, call service, shape the response, pick the
  status code. No validation beyond "is this JSON". No domain knowledge.
- **`service.py`** — translation. Validates and shapes incoming payloads, calls logic and
  providers, maps domain objects to plain JSON-serializable dicts. Raises `ValueError` for
  bad input; the router turns that into a 400.
- **`logic.py`** — pure domain. Knows nothing about HTTP, JSON, or Flask. Never imports
  `flask` or `request`. This is where scoring/normalization lives, and it must stay
  importable and testable with zero network and zero config.

Lower layers never import upper layers.

**Documented deviation from the template:** the template uses flat modules (`import service`)
run as `python main.py`. This repo has multiple components, so `matcha/` is a real package
with relative imports (`from . import service`), run as `python -m matcha.main`. The
*layering* is what carries over, not the import mechanism.

## Authorization

matcha's callers are the clients: y-the-md and every spice-ify, possibly on other machines.
They all share **one optional bearer token**. matcha holds live session state (who is
connected, what each plays, work in flight) but no user accounts and no per-user platform
tokens — a listener's own Spotify login stays inside their Spotify client.

- Default: bind `127.0.0.1`, no auth.
- Remote hosting (Spotify listeners on other machines): set `MATCHA_TOKEN` (`MATCHER_TOKEN`
  still accepted); requests then need `Authorization: Bearer <token>`. Compared with
  `hmac.compare_digest`. When the env var is unset the guard is a no-op. `/api/v1/health`
  stays open as a liveness probe.

Do not add user accounts, JWTs, per-user sessions, or OAuth to matcha. If a feature seems to
need them, it belongs in a client.

## Matching rules

- **ISRC is the canonical cache key, not the lookup mechanism.** Spotify exposes ISRC and
  supports `isrc:` search; YouTube Music exposes neither. So fuzzy matching is the primary
  discovery path in *both* directions, and ISRC is how we store a confirmed pair so it's
  never recomputed.
- Scoring is a weighted composite of title, artist, and duration similarity, with vetoes.
  **Duration is the strongest cheap signal** — it's what separates a studio track from the
  live/extended/nightcore version with the same title.
- All scoring is pure and lives in `logic.py`. Provider I/O never leaks into it.
- Matches are cached in SQLite. A cache hit must never hit the network.

## Python conventions

- **No virtualenvs.** This project runs on system `python3`. Do not create `.venv`, do not
  run `python -m venv`, do not invoke a venv interpreter.
- **Dependencies come from apt.** Prefer a `python3-*` Debian package every time one exists.
  System python is PEP 668 `EXTERNALLY-MANAGED`; never run `pip install` against it, and
  never reach for `--break-system-packages`. If something genuinely isn't packaged, document
  it in `DEPENDENCIES.md` and let the user install it — don't install it yourself.
- Adding a dependency that apt doesn't carry needs a real justification, because it costs the
  user a manual step.
- Standard library first. Current third-party deps: `flask`, `rapidfuzz`, `spotipy`,
  `ytmusicapi`. Adding another needs a reason. Build-only: `python3-pyinstaller`, which
  `scripts/build.py` runs with `python3 -S` against Debian's packages and `vendor/` only, so
  nothing pip-installed under `/usr/local` or `~/.local` can leak into `dist/matcha`.
- `matcha/requirements.txt` records version floors for reference only. It is not the install
  path on this machine; `DEPENDENCIES.md` is.
- Type hints on anything crossing a layer boundary.
- `logic.py` must import cleanly with no credentials present. Providers initialize lazily so
  the service boots and tests run without secrets.
- Secrets come from env only. Never commit credentials; `.env` is gitignored.

## Testing

- `python3 -m pytest tests/ -q` from the repo root, using system python.
- `cd y-the-md && bun test` for y-the-md (Bun's built-in runner; no extra packages).
- `logic.py` gets real unit tests — it's pure, it's the part that's actually subtle, and it
  needs no mocks.
- Don't write tests that require live Spotify/YTM credentials.

## Repo notes

- `temp/` is the user's Flask API template, vendored for reference with its own nested
  `.git`. It is not part of the build. Leave it alone unless asked.
