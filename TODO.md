# Roadmap

Ordered by what unblocks what, not by appeal.

## Now

- [x] **Matcher test suite green** — 52 tests pass. Two real bugs found and fixed on first
      run: apostrophes were being split into separate tokens (`pepper s`), and the
      artist-veto floor of 0.30 let karaoke credits through (raised to 0.50, plus an
      explicit impostor-credit veto).
- [x] **Matcher validated against live YouTube Music** — 6/6 trap-heavy titles resolved to
      the correct artist at confidence 1.0, plus a live Spotify-MPRIS → YTM round trip.
      Note YTM reports whole-second durations, so expect ±1000ms deltas.
- [ ] **Matcher: Spotify provider blocked on Premium.** Credentials load correctly, but
      `/v1/search` returns `403 Active premium subscription required for the owner of the
      app` — Feb 2026 dev-mode rules cover client-credentials search too, not just user
      OAuth. Until the app owner holds Premium, **ytm→spotify matching has no provider.**

      **With YTM as leader and bidirectional queue sync, this is now on the critical path.**
      ytm→spotify is the hot direction under YTM leadership, and it needs Spotify search.
      Two independent Premium requirements apply:

      | Need | Who must have Premium |
      |---|---|
      | catalogue search (client credentials) | the app owner |
      | queue write (`POST /me/player/queue`) | **each end user** |

      Routes around it:
      - **Spicetify** — search *and* queue through the logged-in client. No dev app, no
        owner Premium, no OAuth slot. Best option if Premium isn't wanted.
      - MusicBrainz for ISRC resolution (free, no auth) — yields an ISRC, not a Spotify id,
        so it only half-solves search and does nothing for queue.
      - Free-tier participants can still sync via MPRIS (read/seek/transport), just without
        queue. Degrade to that; don't exclude them.
- [ ] **Sync state machine — the hard part, and entirely unbuilt.** Nothing currently
      connects the two platforms, so there is no sync and equally no cross-sync risk yet.
      What it must handle:
      - **Echo suppression.** YTM change → push to Spotify → Spotify reports the change →
        push back to YTM → loop. Every write we originate must be tagged and ignored when
        it comes back as a read.
      - Authority direction (YTM default, configurable — constraint 4).
      - Debouncing, and the crossfade guard window (constraint 11).
      - Unmatched tracks: what plays on the far side when nothing matches.

- [x] **`y-the-md` wired to `matcha`.** `--match` resolves the live YTM track; `--match-queue`
      pre-matches the next 5. Distinguishes "matcha down" from "matcha up, provider down"
      and degrades rather than failing.
- [x] **`spice-ify` relay built and proven.** A Spicetify extension cannot listen on a port,
      so it polls `POST /api/v1/spotify/pending` and answers via `/spotify/result`.
      Verified end-to-end: with the Web API returning 403, a `ytm→spotify` match
      **automatically fell back to the relay** and resolved at confidence 1.0. Command
      round-trip (`/spotify/command`) works too.
      `providers/__init__.py` is now a facade: Web API first (it returns ISRCs), spice-ify
      second, with per-route detail in `/health`.
- [ ] **Load `spice-ify` into the real Spotify client.** Everything so far used a simulated
      extension speaking the same protocol. `cd spice-ify && bun run install-ext`, then
      `spicetify config extensions spice-ify.js && spicetify apply`. Watch for CSP blocking
      `fetch` to `127.0.0.1:8080` — that is the one unproven assumption.
- [ ] **Spotify without the Web API — the route that dodges the 403.** On a desktop with
      Premium, **MPRIS + Spicetify together need no Web API at all**: MPRIS gives position,
      seek and transport; Spicetify gives search and queue through the already-logged-in
      client. No dev app, no client ID, no OAuth slot, no 5-user cap, **and no owner
      Premium** — which is what currently blocks `matcha`'s Spotify provider.

      This makes the Spicetify tier strategically important rather than a nice-to-have:
      it is the only Spotify path that works today given the 403. The Web API tier remains
      the zero-install floor for anyone who won't install Spicetify, and for mobile.
- [x] **Install pear-desktop** (3.12.0) — done. Still to do: enable its api-server plugin,
      and change `hostname` from `0.0.0.0` to `127.0.0.1` (`DEPENDENCIES.md` Part 4b).
- [x] **`mt-peer/`: join Music Together as a guest peer** — working, verified live against
      pear-desktop 3.12.0. Bun + `peerjs` + `node-datachannel`. Joins with nothing but the
      host id, receives `SYNC_PROGRESS` at 1 Hz, and **guest writes are honoured**: a
      `state: 2` echo paused the host within 1s and held.
- [x] **`mt-peer/`: pause, seek and queue-write all verified as a guest.** Pause held until
      a human resumed; seek jumped 44.7s → 30.1s; `ADD_SONGS` was accepted and echoed back
      to all peers. **The YouTube Music side is effectively under full control.**
- [x] **Queue read solved.** `SYNC_QUEUE` (full 57-track list) fires on **track change**
      (91ms after the index advanced) and on **queue mutation** (~4s after our own add).
      Never on join. No api-server needed — a peer just waits for the first trigger.
- [x] **Queue writes verified working end-to-end.** `ADD_SONGS` at `index: currentIndex + 1`
      lands in the real queue and plays; `SET_INDEX` jumps to it immediately (index 1 → 2,
      held, audio changed). The earlier "it never appeared" was two separate red herrings:
      a bare **append** goes past the autoplay horizon and is unreachable, and the queue UI
      only renders an inserted track once playback reaches it. **The YouTube Music side now
      supports read, seek, transport and queue write in full.**
- [ ] **Use api-server for rich local reads** (constraint 9). `GET /song` returns full
      metadata where Music Together carries only `{videoId, ownerId}`, and `GET /queue/next`
      gives the upcoming track — which is what makes pre-matching possible. Still
      `enabled: false` in the user's config; needs turning on.
- [ ] **Pre-match upcoming tracks.** With `GET /queue`/`queue/next` we can resolve YTM →
      Spotify *before* the transition instead of at it, which is what makes one-directional
      YTM → Spotify queue push viable.
- [ ] **Queue state tracker.** Maintain the queue from a `SYNC_QUEUE` baseline plus
      `ADD_SONGS` / `REMOVE_SONG` / `MOVE_SONG` / `SET_INDEX` deltas, and re-baseline on
      every fresh `SYNC_QUEUE`. Needed before the sync engine can diff two queues.
- [ ] **Cold-start gap.** A peer joining mid-song is queue-blind until the next track
      change. Decide: accept it, or read `GET /api/v1/queue` once for an instant baseline.
- [ ] **`mt-peer/`: reconnect + resync.** The peer must survive the host closing or
      restarting a session, and re-fetch the snapshot on reconnect.
- [ ] Only use Reoudevouz server where needed. Use Websocket for YTMD and ideall for spotify prbly not possible but fix to not hammer the server with requests

### Considered and deprioritised

- **Spotify Web Playback SDK** — creates a browser-based Connect device we fully control.
  Requires *full* Premium (mobile-only plans excluded) and, decisively, **relocates audio
  into the browser**: the participant stops listening through their Spotify app. Wrong
  trade for "people use their normal Spotify".
- **raspotify / librespot** — same shape: a Connect device we control, Premium required,
  audio comes out of *that* device rather than the user's app. No Jam support either
  ([#1576](https://github.com/librespot-org/librespot/issues/1576)). Genuinely useful only
  for a shared-speaker setup, which is a different product.

- [ ] **Agent: MPRIS adapter — transport only.** Do this first among Spotify adapters — it's the only one that works
      for *both* platforms, needs no plugin, no credentials and no client ID, and it was
      confirmed working on this machine (both players report `CanSeek=true`). It gives
      `read` + `seek` + `transport`; it gives no `append`, since neither player implements
      the MPRIS `TrackList` interface.
- [ ] **Agent: pear api-server adapter** — adds `append` (queue) on the YT Music side, which
      MPRIS cannot do.
- [ ] **Agent: capability probe.** On startup, detect which adapters are usable on this
      machine and report the union to the server. No hardcoded assumptions about what a
      participant is running.
- [ ] **Bridge: adapter interface with declared capabilities** (`read` / `append` /
      `seek` / `transport`). Do this *before* the first Spotify adapter, not after —
      retrofitting capability tiers onto a single hardcoded adapter is the expensive
      version of this work.
- [ ] **Bridge: Spotify adapter, Web API tier** — polling + queue append, per
      constraint 2 in AGENTS.md. Declares `read` + `append`, no `seek`.

## Client integrations

### Spicetify extension for Spotify — second tier, not a replacement

**Both Spotify paths ship.** The Web API adapter is the floor: it works for anyone with
a Spotify account and asks them to install nothing. The Spicetify extension is the
ceiling: much better sync, but only for people already running Spicetify. Nobody gets
excluded for not running Spicetify, and nobody running it is stuck at the floor.

This means the bridge needs a **Spotify adapter interface with two implementations**,
and the sync engine has to cope with participants of differing capability. See
"Capability tiers" in AGENTS.md — that constraint is what makes this work rather than
turning into two half-projects.

A Spicetify extension runs *inside* the Spotify desktop client, so it gets
[`Spicetify.Platform.PlayerAPI`](https://spicetify.app/docs/development/api-wrapper/methods/platform):

| Capability | Web API path (current) | Spicetify extension |
|---|---|---|
| Read playback position | ~1s polling, rate-limited | direct, event-driven |
| Seek | ✗ (host-only in a Jam) | ✅ `seekTo` / `seekBy` |
| Play / pause / resume | Premium + quota | ✅ direct |
| Queue add / remove / clear | append only | ✅ `addToQueue`, `removeFromQueue`, `clearQueue` |
| Spotify client ID needed | yes | **no** |
| 5-user dev-mode cap | applies | **does not apply** |
| Listener must install something | no | Spicetify + our extension |
| Mobile | works | ✗ desktop only |

The quota row is the payoff: the extension never touches the Web API, so the March 2026
quota regime simply doesn't apply to it — no client ID, no allowlist, no 250k-MAU wall.
The install row is the price, and it's why the Web API tier stays.

**Important:** we write **our own** extension talking to our bridge — we do not bridge
into someone else's. Native Spotify Jam stays out of the picture on this path, which is
exactly what makes it clean.

Prior art to read first, not to depend on:

- [Kyzenkms/spicetify-jam](https://github.com/Kyzenkms/spicetify-jam) — independent
  listen-together over **WebRTC P2P, host/guest, TURN fallback, drift correction**.
  Actively maintained (v1.2.3, July 2026), TypeScript. Note it is architecturally the
  *same shape* as pear-desktop's Music Together — two open P2P protocols, which is why
  bridging them is tractable where native Jam is not.
- [FlafyDev/spotify-listen-together](https://github.com/FlafyDev/spotify-listen-together)
  — alternative approach.
- [t1mlange/spotify-group-session](https://github.com/t1mlange/spotify-group-session) —
  obsolete since Spotify shipped native Jams in client ≥1.2.48, but useful history.

Open questions before committing:
- Does `Spicetify.Platform` expose anything for *native* Jam? Documented Platform APIs
  (ClipboardAPI, History, LocalStorageAPI, PlatformData, Session, Translations) show
  **no** SessionAPI/SocialConnect/group-session surface. Needs checking against a live
  client — if native Jam were reachable, we'd get zero-install *and* full control.
- Spicetify breaks on Spotify client updates. How much maintenance does that impose?
- Transport from extension → bridge: plain WebSocket to the bridge is simplest, and
  avoids the WebRTC/TURN complexity spicetify-jam needs for direct P2P.

### pear-desktop plugin for YouTube Music — later

Symmetric to the above: replace "run pear-desktop locally and read its api-server" with
a first-party pear-desktop plugin that talks to the bridge directly. pear-desktop already
has a plugin system, so this is a well-trodden path.

Lower priority because the api-server plugin already gives us what we need on the YTM
side — this is cleanup, not capability. The endgame is both ends being first-party
plugins with the bridge purely as a relay + matcha, at which point the pear-desktop
instance running locally as a "reader" disappears.

### Mobile support — wanted, and the hardest thing on this list

Goal: listen together with someone on a **phone**, not just a Linux desktop. This is a
real milestone, not a nice-to-have — it's the difference between "works at my desk" and
"works when either of us is out".

Every mechanism the project currently relies on is desktop-only:

| Mechanism | Mobile? | Why |
|---|---|---|
| MPRIS | ✗ | D-Bus session bus; Linux desktop only |
| Spicetify | ✗ | patches the *desktop* Spotify client |
| pear-desktop / Music Together | ✗ | Electron desktop app |
| Spotify Web API | **✅** | plain HTTP, device-agnostic |

So **the Web API is the only route to a phone** — which makes the Premium blocker
(constraint 3) matter much more than it does for desktop-only sync, and it inherits every
Web API limitation: no seek, queue only, ~1s polling.

Plausible shapes, roughly in order of effort:

1. **Spotify-on-mobile as a follower.** The phone runs plain Spotify; the bridge drives it
   via `POST /me/player/queue` and transfer-playback. Read via `currently-playing`. Loose
   sync (±2–3s, no seek), but no app to install and it works today apart from Premium.
   **Start here.**
2. **YouTube Music on mobile** — no Music Together on mobile at all, and no api-server, so
   there is currently *no* mechanism. Would need the official YTM app's cast/queue
   behaviour, which we do not control. Treat as blocked pending research.
3. **A small companion app / PWA** that speaks to `server/` and controls playback via the
   Web API. Most work, most control, and needs distribution.

Open question worth answering before building any of it: does Spotify Connect
*transfer-playback* to a phone behave well enough to keep a mobile follower in sync, or
does it fight the phone's own player? Cheap to test with two devices.

(Linux phone is noted as explicitly rejected.)

### Session state — fix the single point of truth, and expose it

**matcha is currently a single point of truth, and a bad one.** All live session state
(who is connected, what each client plays, pending commands) lives in one in-memory
`Relay` inside one Flask process. Consequences:

- matcha restarts → every client silently drops out until its next state push
- matcha down → no sync at all, and clients only find out on their next poll
- nothing is observable except by scraping `/spotify/state`
- the relay is per-process, so matcha can never run more than one worker

Not urgent — a friend-group bridge does not need HA — but it should be *deliberate*
rather than accidental. Options, cheapest first:

1. **Keep it in-memory, make it honest.** Document the restart behaviour, have clients
   re-announce on reconnect, and add a session epoch so a client can tell it was dropped.
2. Persist just enough to survive a restart (SQLite, same as the match cache).
3. Split the relay out of matcha so matching and session state fail independently.

- [ ] **Expose a "currently playing" endpoint** *(later — explicitly deferred)*.
      One read that answers "what is everyone listening to right now", rather than making
      callers assemble it from `/spotify/state`. Something like:

      ```
      GET /api/v1/now  ->  { leader: {...}, clients: [{platform, title, artist,
                             position_ms, paused, in_sync, drift_ms}], synced: bool }
      ```

      Useful for a status UI, for debugging drift, and for answering "is it actually
      working" without reading four different endpoints. Should include **drift per
      client** since that is the number that says whether sync is healthy.

### Queue sync — mirror adds, do NOT reconcile queues

**Do not build a single-source-of-truth shared queue.** It is a trap, for reasons that are
now established and confirmed in practice:

- **The bridge (matcha) cannot read or write either queue.** It has no local hooks and no
  usable tokens (Web API 403; Music Together / api-server / Spicetify are client-local). All
  queue access goes through y-the-md and spice-ify; matcha only relays.
- **Full reconciliation needs the matcher on every entry.** Two queues hold different IDs
  (`videoId` vs `spotify:track:`), so making them identical means matching *every* track —
  dozens of Spotify searches per reconcile, straight back into rate-limit territory.
- **Autoplay generates divergent infinite tails** that can never agree, so any
  "keep the queues identical" logic fights the players forever. Autoplay can't be disabled.

**Instead: mirror deliberate additions only.** The "now playing + seek" contract
(constraint 10) already keeps both on the same song. Queue sync is then just an event mirror:

1. A client detects a *human* add — its queue gained a track the user chose (distinguish
   from an autoplay-generated tail entry, and from our own mirrored add via echo suppression).
2. It reports that one add to matcha.
3. matcha matches that single track and relays one `enqueue` to the other client.

One search per human action, no shared truth, no fighting autoplay. Each client remains the
only reader/writer of its own queue; matcha is a matching relay, never a queue owner.

Open question: reliably detecting a *human* add vs an autoplay-tail change vs our own echo.
Likely needs each client to diff its queue between reports and classify the delta.

### Bidirectional search — TODO only, do not implement yet

Today search is one-directional: **YTM → Spotify**, because YouTube Music is the leader
(constraint 4). The leader's current track is resolved onto the follower's platform via:

- **Spotify search:** the spice-ify relay (yt-dlp model — the logged-in client's internal
  `searchModalResults` GraphQL). Implemented and primary.
- **YTM search:** `ytmusicapi` (also unofficial — the yt-dlp model for YouTube Music).

To let **Spotify be the leader**, we need the reverse direction too: resolve a *Spotify*
track onto YouTube Music. `ytmusicapi` already does Spotify→YTM search fine (it's just a
YTM catalogue search by title/artist), so the matcher direction is symmetric on paper. What
is missing for true bidirectional operation:

- A **Spotify → YTM** hot path that is as robust as the YTM → Spotify one, including the
  same failure backoff and caching.
- The engine already supports either leader (`SYNC_LEADER`), but the *runner's* mapping and
  the client capability assumptions were built and tested with YTM as leader — audit them.
- Decide what "leader" means when **both** sides can originate changes (a real jam lets
  anyone queue). This overlaps with the bidirectional play/pause work already done: extend
  last-writer-wins from transport to track selection, with echo suppression, so a song
  picked on *either* platform propagates to the other.

Note: a server-side anonymous Spotify search (no extension needed) was considered as an
alternative to the relay, but Spotify's anonymous-token endpoint now requires TOTP and is
frequently broken upstream (librespot#1475). The logged-in-client relay is the reliable
path; revisit the anonymous route only if it stabilises.

## Later

- [ ] Persist match corrections — let a human override a bad match and have it stick.
- [ ] Web UI for session status / drift / unmatched tracks.
- [ ] Handle tracks that exist on neither side (local files, region-locked, podcasts).
