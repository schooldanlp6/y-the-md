# Dependencies

## TL;DR — everything still outstanding

```bash
sudo apt install python3-flask python3-rapidfuzz python3-pytest python3-spotipy python3-dasbus
```

For `mt-peer/` (Bun 1.3.5 already installed — **not** Node):

```bash
cd mt-peer && bun install
```

Two packages: `peerjs` (same client library pear-desktop uses) and `node-datachannel`
(WebRTC for a non-browser runtime — the project's only native dependency, loaded via
N-API). `y-the-md/node_modules` is a symlink to these, so this one install serves y-the-md
too. TypeScript runs directly under Bun with no `tsc`; the only build step is packaging
into `dist/` with `python3 scripts/build.py` (see README.md → Build).

Then, in **pear-desktop → Plugins** — checked against your actual `config.json`, so this
is only what's genuinely left:

| Plugin | State right now | Action |
|---|---|---|
| **Shortcuts** (MPRIS) | ✅ `enabled: true` | none — MPRIS is already live |
| **Crossfade** | ✅ `enabled: true`, `secondsBeforeEnd: 6` | none here, but **fix Spotify** — see below |
| **API Server** | ❌ `enabled: false` | **enable it**, and set `hostname` → `127.0.0.1` (defaults to `0.0.0.0`) |

**Your two players are currently mismatched on crossfade.** pear-desktop is at 6s;
`~/.config/spotify/prefs` has no crossfade key at all, which means off. Set Spotify to
**6 seconds** (Settings → Playback → Crossfade) so both sides agree — that write is what
creates the `audio.crossfade_time` key the agent reads. Part 6 explains why this matters.

Everything else is already done: `youtube-music` 3.12.0, vendored `ytmusicapi`,
`python3-flask`, `python3-requests`, node/npm. Spicetify (Part 5) is not needed yet.

---

System python only — **no venv**. Everything that can come from apt does.

Target interpreter: `python3` (3.13.5 on this box). Debian marks it
`EXTERNALLY-MANAGED` (PEP 668), so `pip install` into the system tree is blocked by
design. That's fine — only one package isn't packaged, and it needs no pip.

**Contents**

| | What | When you need it |
|---|---|---|
| Steps 1–3 | Python packages (apt + `vendor/`), incl. **1b: D-Bus/MPRIS** | now — the matcha and the agent |
| Part 4 | **pear-desktop** + its api-server plugin | before the agent can read YouTube Music |
| Part 5 | Spicetify + Node toolchain | later — the Spotify extension tier (see `TODO.md`) |
| Part 6 | **Crossfade** — one canonical value, set in the server env | before two clients ever sync |

Already present on this machine, nothing to do: `node` 26.3.0, `npm` 11.16.0, `git`,
`curl`, `wget`, `unzip`, and `python3-flask`.

## Step 1 — apt (covers everything except one)

```bash
sudo apt install python3-rapidfuzz python3-pytest python3-spotipy python3-requests
```

| Package | apt version | Needed for |
|---|---|---|
| `python3-flask` | *already installed* | HTTP layer |
| `python3-rapidfuzz` | 3.12.2 | match scoring (`matcha/logic.py`) |
| `python3-spotipy` | 2.25.1 | Spotify catalogue search |
| `python3-pytest` | 8.3.5 | test suite |
| `python3-requests` | — | required by ytmusicapi in step 2 |

After this step **the test suite and the service both run.** Step 2 is only needed
before you first hit the YouTube Music provider for real — both providers
lazy-import their client, so a missing `ytmusicapi` can't break boot or tests.

## Step 1b — D-Bus bindings (for the MPRIS adapter)

MPRIS is how the agent reads and controls both Spotify and YouTube Music locally. All
three Python D-Bus bindings are packaged; **`dasbus` is the one to use** — modern,
maintained, and a much nicer API than `dbus-python` for this.

```bash
sudo apt install python3-dasbus
```

| Package | apt version | Verdict |
|---|---|---|
| `python3-dasbus` | 1.7-2 | **use this** |
| `python3-dbus` | 1.4.0-1 | works, older C-binding API |
| `python3-pydbus` | 0.6.0-6 | simplest API, but upstream is unmaintained |

Verify against a running player — no code needed:

```bash
busctl --user list | grep mpris
busctl --user get-property org.mpris.MediaPlayer2.spotify \
  /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player Metadata
```

**Bus names are not stable — discover, never hardcode.** On this machine YouTube Music
registers as `org.mpris.MediaPlayer2.YoutubeMusic`, while upstream docs say
`org.mpris.MediaPlayer2.youtube-music`. The agent must enumerate `org.mpris.MediaPlayer2.*`
and identify players by the `Identity` property (`"YouTube Music"`, `"Spotify"`).

## Step 2 — ytmusicapi (not in Debian), into `vendor/`

`ytmusicapi` 1.12.1 is a **pure-Python wheel** (`py3-none-any`) whose only runtime
dependency is `requests>=2.22`, which apt just installed. There is a directory in the
repo for exactly this case — [`vendor/`](vendor/README.md). `matcha/__init__.py` puts
it on `sys.path`, so unpacking a wheel there is all the installation there is: no pip,
no venv, no `PYTHONPATH`, and nothing written outside the repo.

```bash
python3 scripts/fetch_vendor.py          # resolve, checksum, unpack into vendor/
python3 scripts/fetch_vendor.py --check  # report what's missing, change nothing
```

The script pins the version, refuses any wheel that isn't `py3-none-any`, verifies the
SHA-256 PyPI publishes, and **skips any package the system already provides** — so if
Debian ever ships `python3-ytmusicapi`, apt wins and `vendor/` quietly goes unused.

By hand instead, if you'd rather: download the `.whl` (not the `.tar.gz`) from
<https://pypi.org/project/ytmusicapi/#files> and `unzip -o ytmusicapi-*.whl -d vendor/`.
Identical result — a wheel is a zip whose top-level entries are the packages.

`vendor/` is gitignored apart from its README, so a fresh clone starts empty and re-runs
the fetch. To undo the whole thing: `rm -rf vendor/ytmusicapi vendor/ytmusicapi-*.dist-info`.

**Alternative — per-user site directory.** If you'd rather have it available to every
project on the box than only this repo, unpack the same wheel into
`$(python3 -m site --user-site)` (normally `~/.local/lib/python3.13/site-packages`).
Python picks that up automatically and Debian's managed tree stays untouched. `vendor/`
is the default because it keeps the dependency with the code that needs it.

## Step 3 — verify

Run from the repo root:

```bash
# should print: all deps ok  (or name exactly what's still missing)
python3 -c "
import importlib
import matcha   # REQUIRED: activates vendor/ on sys.path before checking ytmusicapi
missing = []
for m in ['flask','rapidfuzz','spotipy','pytest','dasbus','ytmusicapi']:
    try: importlib.import_module(m)
    except ImportError: missing.append(m)
print('all deps ok' if not missing else 'MISSING: ' + ', '.join(missing))
"

# test suite — should be green with step 1 alone
python3 -m pytest tests/ -q

# service boots and answers on /api/v1
python3 -m matcha.main &
curl -s localhost:8080/api/v1/health
```

`/api/v1/health` reports per-provider availability, so it will tell you plainly
whether step 2 landed:

```json
{"status": "ok", "providers": {"spotify": true, "ytm": true}, "auth": "none"}
```

## Note on `matcha/requirements.txt`

That file records version floors for reference and for anyone deploying elsewhere.
**It is not the install path on this machine** — use the apt commands above. Don't
`pip install -r` it into system python; PEP 668 will refuse, and rightly.

---

# Part 4 — pear-desktop (needed before the bridge works)

The bridge reads YouTube Music state from a locally running pear-desktop with its
**api-server plugin** enabled. Without this there is no YTM side at all, so this is a
hard requirement for the bridge — not an optional extra.

## 4a. Get it

Latest is **v3.12.0** (2026-06-28) and there is a proper Debian package, so no AppImage
juggling:

```bash
cd /tmp
wget https://github.com/pear-devs/pear-desktop/releases/download/v3.12.0/youtube-music_3.12.0_amd64.deb
sudo apt install ./youtube-music_3.12.0_amd64.deb
```

Using `apt install ./file.deb` rather than `dpkg -i` lets apt pull any missing
dependencies in the same step. Other artifacts on the
[releases page](https://github.com/pear-devs/pear-desktop/releases) if you'd rather:
`.AppImage`, `.rpm`, `.tar.gz`, `.snap`, `.freebsd` — the `.deb` is the right one here.

## 4b. The three hooks into YouTube Music

We attach to pear-desktop in **three** places. They are complementary, not alternatives —
each supplies something the other two cannot:

| Hook | Transport | Scope | Supplies |
|---|---|---|---|
| **Music Together** | WebRTC / PeerJS | **the whole shared session** | position + state @1 Hz, seek, pause/play, queue read *and* write |
| **api-server** | HTTP `:26538` | this machine only | **track metadata**, upcoming track, catalogue search, transport |
| **MPRIS** | D-Bus | this machine only | transport (skip/stop/pause), seek, basic metadata |

Why all three:

- **Music Together is the only one that reaches other people.** The other two control the
  local pear-desktop and nobody else's. It is also the only hook that needs no setup on the
  listener's side beyond joining the session.
- **api-server is the only source of track metadata.** Music Together carries only
  `{videoId, ownerId}` — no title, artist or duration. `GET /song` returns the lot, and
  `GET /queue/next` gives the upcoming track, which is what makes pre-matching possible.
- **MPRIS is the cheap fallback.** Zero config, already running, and it works even if the
  api-server plugin is off. Transport only — never treat it as the source of truth
  (constraint 10).

Setup for each follows.

### Hook 1 — Music Together (no configuration)

*Plugins → Music Together.* One participant **hosts**; the plugin copies a peer id to the
clipboard. Everyone else — including `mt-peer` — joins with that id and nothing else. No
account, no token, no port, no firewall rule.

```bash
cd mt-peer && bun run src/main.ts <host-peer-id>
```

The id changes every time a session is restarted, so it has to be handed over per session.
That is currently the only manual step in the whole YouTube Music path.

### Hook 2 — api-server

**It ships disabled.** Enable it in-app: menu → *Plugins* → *API Server* → enable, then
open its options.

Defaults, from the plugin's `config.ts`:

| Setting | Default | Use |
|---|---|---|
| `enabled` | `false` | → **turn on** |
| `hostname` | `0.0.0.0` | → **change to `127.0.0.1`** |
| `port` | `26538` | keep |
| `authStrategy` | `AUTH_AT_FIRST` | keep |
| `secret` | generated | leave alone; the bridge authorizes once |
| HTTPS | off | leave off for a local bridge |

**Change the hostname.** `0.0.0.0` publishes full playback control of your music client
to every interface on the box, including your LAN. The bridge runs on the same machine,
so `127.0.0.1` costs nothing and closes that. Same reasoning as the matcha's default
bind (see `AGENTS.md` → Authorization).

`AUTH_AT_FIRST` means the first client to connect gets authorized and added to
`authorizedClients`. So the bridge will need a one-time approval on its first
connection — expected, not a fault.

### Hook 3 — MPRIS

*Plugins → Shortcuts.* **Already enabled on this machine** (`shortcuts.enabled: true` in
`config.json`), which is why `org.mpris.MediaPlayer2.YoutubeMusic` is already on the session
bus. Nothing to do.

Bus names are not stable — this machine registers `…MediaPlayer2.YoutubeMusic` while
upstream docs say `…MediaPlayer2.youtube-music`. Enumerate `org.mpris.MediaPlayer2.*` and
match on the `Identity` property (`"YouTube Music"`), never on a hardcoded name.

## 4c. Verify all three

```bash
# hook 2 — api-server (needs 4b done)
curl -s localhost:26538/api/v1/song        # current track WITH metadata
curl -s localhost:26538/api/v1/queue/next  # upcoming track

# hook 3 — MPRIS (works now)
busctl --user get-property org.mpris.MediaPlayer2.YoutubeMusic \
  /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player PlaybackStatus

# hook 1 — Music Together (needs a live session id)
cd mt-peer && bun run src/main.ts <host-peer-id>
```

pear-desktop's api-server also versions its routes under `/api/v1`, which is where our
own convention came from — expect the two to look similar and don't confuse them: the
matcha is port **8080**, pear-desktop is **26538**.

---

# Part 5 — Spicetify toolchain (later)

Only needed when we start the Spotify extension tier in `TODO.md`. Nothing here blocks
the matcha or the bridge.

Good news on this machine: **Spotify is installed from apt** (`spotify-client`
1.2.74.477), not snap or flatpak. That's the straightforward case — snap explicitly
cannot be modified and would need reinstalling from apt first.

## 5a. Install Spicetify

```bash
curl -fsSL https://raw.githubusercontent.com/spicetify/cli/main/install.sh | sh
```

Config lands in `~/.spicetify`. If `spicetify` isn't found afterwards, add it to `PATH`.

**Before first run:** open Spotify and stay logged in for ~60 seconds so it generates the
files Spicetify patches. Then give yourself write access to the install dir:

```bash
sudo chmod a+wr /usr/share/spotify
sudo chmod a+wr -R /usr/share/spotify/Apps
```

## 5b. Toolchain

`node` 26.3.0 and `npm` 11.16.0 are already installed — nothing to get. Extensions are
TypeScript compiled to a single JS file dropped in `~/.spicetify/Extensions/`, then
registered with `spicetify config extensions <name>.js && spicetify apply`.

## 5c. Reference implementations

To read before building, **not** to depend on:

```bash
git clone --depth 1 https://github.com/Kyzenkms/spicetify-jam
git clone --depth 1 https://github.com/FlafyDev/spotify-listen-together
```

Clone these outside the repo (or they'll need gitignoring). `spicetify-jam` is the
closest prior art — WebRTC P2P, host/guest, drift correction, actively maintained.

## 5d. Worth checking first

Your Spotify client is 1.2.74, comfortably past the 1.2.48 that introduced native Jams.
Before writing any extension code, open Spotify's devtools console and poke at
`Spicetify.Platform` to see whether anything native-Jam-shaped is reachable
(`SessionAPI`, `SocialConnect`, or similar). The published Platform docs list no such
surface — but if one exists undocumented, the extension tier could drive a *real* Jam and
we'd get zero-install and full control at once. Ten minutes that could remove a whole
tier of work. Recorded as an open question in `TODO.md`.

---

# Part 6 — Crossfade

Crossfade breaks cross-platform sync quietly rather than loudly, which is what makes it
dangerous. With a crossfade of C seconds the next track *starts* C seconds before the
current one ends, so:

- the track-change event fires **early**, by C, and at a player-specific moment
- MPRIS `Position` and `Metadata` are ambiguous during the overlap — two tracks are live
- **the timeline compresses**: N tracks take `sum(durations) − C×(N−1)`, not `sum(durations)`

If two clients disagree about C, their track boundaries diverge by C at *every* transition
and the error accumulates. That's the failure mode: not a crash, just steadily worsening
desync that looks like a drift bug.

## The rule: one canonical value, set in the server env

```bash
# server env
SYNC_CROSSFADE_MS=6000     # canonical for the whole session; 0 disables crossfade sync
SYNC_CROSSFADE_STRICT=1    # 1 = refuse mismatched clients, 0 = warn and continue
```

Every agent reads its local player's crossfade, reports it at handshake, and the server
compares against `SYNC_CROSSFADE_MS`. **Equal values everywhere is the whole requirement** —
the value itself doesn't matter, only that it agrees.

Agents read it from disk rather than trusting a promise:

| Player | File | Key | Units |
|---|---|---|---|
| pear-desktop | `~/.config/YouTube Music/config.json` | `plugins.crossfade.secondsBeforeEnd` (and `.enabled`) | seconds |
| Spotify | `~/.config/spotify/prefs` | `audio.crossfade_time` — **absent means 0** | seconds |

Check yours right now:

```bash
python3 -c "
import json
c = json.load(open('$HOME/.config/YouTube Music/config.json'))['plugins'].get('crossfade', {})
print('pear-desktop:', c.get('secondsBeforeEnd', 0) if c.get('enabled') else 0, 's')
"
grep -E '^audio\.crossfade_time' ~/.config/spotify/prefs || echo "spotify: 0 s (key absent)"
```

## One thing equality alone does not fix

Matching values stops boundaries from *diverging*, but during the C-second overlap the
position readings are still ambiguous, and a seek issued mid-fade aborts the fade audibly
on that client only. So the sync engine needs exactly one extra rule:

> **No seeks inside the guard window** — from `duration − C − margin` to `C + margin` into
> the next track. Let drift ride through the transition and correct after it. `margin` ≈ 1s.

That's it. One config value plus one guard window; no crossfade modelling, no per-track
timeline math.

## Escape hatch

Crossfade `0` on every client is always correct and needs none of the above. If crossfade
handling ever turns into a time sink, that's the fallback — say so rather than building
machinery around it.

---

# Part 7 — Spotify app registration

One app at <https://developer.spotify.com/dashboard> serves **two different purposes**, and
they have very different costs. Register it once, use it both ways.

| | Client credentials | User OAuth |
|---|---|---|
| Used by | `matcha/` catalogue search | agent — queue + playback |
| User authorization | none | per-participant |
| **Premium needed** | **yes — app owner** | yes |
| Counts against the 5-user cap | **no** | **yes** |
| Unblocks | ytm→spotify matching | queue sync on native Spotify |

> **The app owner must hold Spotify Premium, even for client-credentials search.**
> Verified the hard way — a non-Premium owner gets `403: Active premium subscription
> required for the owner of the app` on a plain `/v1/search` call with no user involved.
> This is part of the Feb 2026 dev-mode changes and it applies to the *entire* Web API,
> not just user-authorized endpoints. Spotify also notes that after a subscription change
> it can take a few hours before requests are allowed.

The 5-user cap still doesn't apply to client credentials — but Premium does.

## 7a. Create the app

Dashboard → *Create app*. Note that since Feb 2026 you get **one Client ID per developer**
and the owner account must be Premium, so set it up deliberately.

- **Redirect URI:** `http://127.0.0.1:8888/callback`
  **Not `localhost`** — Spotify explicitly rejects it. HTTPS is required for everything
  *except* loopback, and loopback must be the literal IP (`127.0.0.1` or `[::1]`).
  Enforced for new apps since 2025-04-09.
- **APIs used:** Web API.

## 7b. Client credentials → `.env`

```bash
cp .env.example .env
# fill in SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET
```

`.env` is gitignored. **Never commit the secret**, and never let it reach the agent — the
secret belongs to the server side only.

Verify the previously-untested direction:

```bash
python3 -c "
import matcha
from matcha.logic import Track, best_match
from matcha.providers import spotify
src = Track(id='x', title='Safe and Sound', artists=('Capital Cities',), duration_ms=193000)
c, s = best_match(src, spotify.search(src, 8))
print(f'{c.title} — {\", \".join(c.artists)}  conf={s.confidence}  isrc={c.isrc}')
"
```

That should also print an **ISRC**, which is the cross-platform cache key (see
`AGENTS.md` → Matching rules).

## 7c. User OAuth — only when you need queue sync

Scopes: `user-read-playback-state`, `user-read-currently-playing`,
`user-modify-playback-state`.

Add each participant under *Settings → User Management* (5 max, including you).

**The cap binds less than it looks like it does.** MPRIS already covers read, seek and
transport with no OAuth at all — user OAuth is needed *only* for queue writes. And a
participant on the Spicetify tier does queue operations locally through the extension, so
**Spicetify users consume no slot**. In practice the 5 slots are only spent on
native-Spotify participants who need their queue synced.

**Each agent stores its own refresh token locally and never sends it to the server.** The
server holds no user tokens; that is a security property worth keeping.
