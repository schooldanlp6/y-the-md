# youtube-music-listentogether-and-spotify-jam

This is a YouTube Music to Spotify (Spicetify) bridge to make "Jams" possible again, cross-platform.

```
 YouTube Music listeners                                    Spotify listeners
 (Listen Together guests)                                   (one spice-ify each)

 pear-desktop ──┐                                        ┌── Spotify + spice-ify
 pear-desktop ──┼── Music Together ── HOST pear-desktop  ├── Spotify + spice-ify
                │   (peer to peer)        │              │
                                      y-the-md ── HTTP ── matcha ── HTTP ┘
                                    (on the host)        (the hub: matching,
                                                          relay, sync engine)
```

- **YouTube Music is the host.** Its now-playing and its queue *are* the session.
  Other YouTube Music listeners join through Listen Together (Music Together) and need
  nothing else.
- **Every Spotify listener runs spice-ify**, a Spicetify extension, inside their Spotify
  desktop app. Spotify Jam has no API, so this is how Spotify takes part.
- **matcha is the hub.** It matches songs between the two catalogues, relays work between
  clients, and keeps every Spotify listener on the host's track.
- **y-the-md** connects the host's YouTube Music to matcha.

Session state lives in the host (what plays, what's queued) and in matcha (who is
connected, what is in flight).

---

## Build

```bash
python3 scripts/build.py --check   # lists anything missing, builds nothing
python3 scripts/build.py           # everything; or name targets: matcha y-the-md spice-ify
```

Or through the Makefile: `make check`, `make` (all), `make matcha`, `make y-the-md`,
`make spice-ify`.

| Output | What it is | Needs at runtime |
|---|---|---|
| `dist/matcha` | single executable | glibc, zlib, `ca-certificates`; nothing else |
| `dist/y-the-md` | single executable | glibc; nothing else |
| `dist/spice-ify.js` | single JS file | Spotify desktop with Spicetify |
| `dist/yt-music-jam-api.js` | copy of `spice-ify.js` made by `make` / `make spice-ify` | Spotify extension filename alias |

The executables carry all their dependencies, so nothing has to be installed where they
run. See [Requirements](#requirements) for what the build itself needs.

`scripts/build.py` is the whole build; the root `Makefile` only calls it. What it does:

- **Targets** are `matcha`, `y-the-md` and `spice-ify`, built in that order. Name any subset;
  an unknown name is an error. No names means all three.
- **Prerequisites are checked first, for every requested target.** Anything missing is
  printed as `[MISSING] <target>: <what>  (<how to get it>)` and the script exits 1 without
  building anything. `--check` runs only this step and prints `all build tools present`
  on success. It checks `objcopy`, PyInstaller, Flask, RapidFuzz, Spotipy, Requests and
  certifi from apt, `ytmusicapi` in `vendor/` (matcha); `bun` (y-the-md, spice-ify); and
  that `y-the-md/node_modules` exists (y-the-md). Nothing is installed or downloaded.
- **Output** goes to `dist/`, intermediates to `build/`; both are gitignored and every run
  overwrites the previous artifacts. Each target prints its path and size when done.
  `make` and `make spice-ify` also copy `dist/spice-ify.js` to
  `dist/yt-music-jam-api.js` for the preferred Spicetify extension filename. Running
  `python3 scripts/build.py` directly builds only the canonical `spice-ify.js` output.

Per target:

- **`dist/matcha`**: PyInstaller `--onefile`, run as `python3 -S` with only
  `/usr/lib/python3/dist-packages` and `vendor/` on the path, so pip packages in
  `/usr/local` or `~/.local` are never frozen in. A generated entry shim
  (`build/matcha/matcha_entry.py`) makes the binary read `.env` from the directory it is
  started in and keep the match cache in `$XDG_DATA_HOME/matcha/matches.db` (default
  `~/.local/share/…`) unless `MATCHA_DB` is set. After building, the script checks the
  bundle for ytmusicapi's locale files and RapidFuzz's compiled module, which PyInstaller
  has been seen to drop silently, and fails if either is missing.
- **`dist/y-the-md`**: `bun build.ts <outfile>` in `y-the-md/`, i.e. `bun build --compile`
  of `src/main.ts` into one executable **with node-datachannel's native WebRTC addon
  (`node_datachannel.node`) embedded**. Plain `bun build --compile` would leave the addon
  out, because node-datachannel loads it through `createRequire(import.meta.url)`, and the
  binary would fail on the first Music Together join. `build.ts` rewrites that load into
  a static `require` of the addon's absolute path so the bundler embeds it. It stops with
  an error if the addon isn't in `node_modules`, and fails the build (rather than shipping a
  broken binary) if a node-datachannel update changes how the addon is loaded. The packages
  come from `cd mt-peer && bun install`; `y-the-md/node_modules` is a symlink to
  `mt-peer/node_modules`.
- **`dist/spice-ify.js`**: `bun build src/spice-ify.ts --format iife`. IIFE because
  Spicetify concatenates extensions into one page and plain top-level `var`s would leak
  into other extensions. (`bun run build` inside `spice-ify/` does the same but writes
  `spice-ify/dist/spice-ify.js`; the steps below use the top-level `dist/`.)

---

## Run it for a test

On the **host** machine (the one running the YouTube Music session).

### 0. Before you start

- **pear-desktop** (YouTube Music) is running, with **Plugins → API Server** enabled.
- **Spotify** is running with Spicetify.

### 1. Install the new spice-ify (once per build)

```bash
make spice-ify
cp dist/yt-music-jam-api.js ~/Downloads/specify/Extensions/yt-music-jam-api.js
~/Downloads/specify/spicetify config extensions spice-ify.js-
~/Downloads/specify/spicetify config extensions yt-music-jam-api.js
~/Downloads/specify/spicetify apply          # restarts Spotify
```

(`~/Downloads/specify` is where Spicetify lives on this machine. Elsewhere, use the
`Extensions` folder next to the `spicetify` binary, or `~/.config/spicetify/Extensions`.)

For a quick check that it's alive, open the Spotify console with **Ctrl+Shift+I** and look
for `[spice-ify] starting as spice-ify-… -> http://127.0.0.1:8080`.

### 2. Start matcha (terminal 1)

From the repo root, because it reads `./.env`:

```bash
./dist/matcha 2>&1 | tee /tmp/bridge-matcha.log
```

**Sync is on.** Once both sides are connected, Spotify follows whatever YouTube Music
plays. To watch without acting, start it as `SYNC=0 ./dist/matcha …`.

### 3. Start y-the-md (terminal 2)

```bash
./dist/y-the-md --sync 2>&1 | tee /tmp/bridge-ytmd.log
```

No session id is needed on the host: anything y-the-md puts into the host's queue reaches
every Listen Together guest through pear-desktop itself.

### 4. Check that everything is connected

```bash
python3 scripts/doctor.py
```

You want one `platform=ytm` client (y-the-md) and one `platform=spotify` client per
Spotify listener.

Stop each program with **Ctrl+C**.

---

## Tests

Do them in order. For each one, tell me the test number and what you saw. I read
`/tmp/bridge-matcha.log` and `/tmp/bridge-ytmd.log` and ask matcha directly, so you don't
need to paste logs. Only Spotify's console (Ctrl+Shift+I, lines starting `[spice-ify]`)
can't be read from outside, so mention anything odd from there.

> Songs you add go into the real queue. If friends are in your Listen Together session,
> they will see them too.

| # | Do | Expect |
|---|---|---|
| 1 | Start everything (steps 1–4). | doctor shows both clients. Nothing in the logs says `error`. |
| 2 | Play something on YouTube Music. | Within ~3 s Spotify plays the same song at about the same position. Pausing either side pauses the other. |
| 3 | **In Spotify, right-click a song → Add to queue.** | Within ~5 s: a Spotify notification *"Queued for everyone: …"*, the song leaves Spotify's *Next in queue*, and it appears in YouTube Music **directly after the current song**. |
| 4 | Add **two** songs in Spotify quickly, A then B. | The YouTube Music queue reads *current, A, B*, in that order. **This is the one thing I couldn't check offline.** |
| 5 | Let YouTube Music reach A (or skip to it). | Spotify plays exactly the version you queued. |
| 6 | Add a song YouTube Music doesn't have (something obscure). | A notification saying it *"stays in your queue only"*, and it stays in Spotify's queue. |
| 7 | Stop matcha (Ctrl+C), add a song in Spotify, start matcha again. | Within ~10 s of matcha being back (once y-the-md has reconnected), the song is forwarded as in test 3. |
| 8 | *(optional)* A friend joins your Listen Together session. | Songs added from Spotify show up in their queue too. |
| 9 | *(optional)* A second Spotify listener, see below. | Their adds land in YouTube Music the same way. Both Spotify players follow. |

### A Spotify listener on another machine

matcha has to listen on the network and needs a token:

```bash
MATCHA_HOST=0.0.0.0 MATCHA_TOKEN=<pick-a-secret> ./dist/matcha 2>&1 | tee /tmp/bridge-matcha.log
MATCHA_TOKEN=<same-secret> ./dist/y-the-md --sync 2>&1 | tee /tmp/bridge-ytmd.log
```

On their machine, install spice-ify as in step 1. Then in Spotify's console
(Ctrl+Shift+I) run:

```js
localStorage.setItem('spice-ify:matcha-url', 'http://<host-ip>:8080')
localStorage.setItem('spice-ify:matcha-token', '<same-secret>')
```

…and reload Spotify (Ctrl+Shift+R).

---

## Settings

| Where | Setting | Default | What it does |
|---|---|---|---|
| matcha | `MATCHA_HOST` / `MATCHA_PORT` | `127.0.0.1` / `8080` | where it listens |
| matcha | `MATCHA_TOKEN` | unset (open) | required bearer token; set it whenever matcha is reachable off this machine |
| matcha | `SYNC` | `1` | `0` = observe only, send no commands |
| matcha | `SYNC_LEADER` | `ytm` | which platform leads |
| matcha | `SYNC_CROSSFADE_MS` | `0` (`6000` in `.env`) | must match the crossfade on every client |
| matcha | `MATCHA_DB` | `~/.local/share/matcha/matches.db` (from source: `matcha/matches.db`) | match cache |
| y-the-md | `MATCHA_URL` / `MATCHA_TOKEN` | `http://127.0.0.1:8080` / unset | where matcha is |
| y-the-md | `YTMD_MT_HOST_ID` | unset | join a Music Together session as a guest. Only needed when y-the-md is *not* on the host machine |
| spice-ify | `spice-ify:matcha-url` / `spice-ify:matcha-token` | `http://127.0.0.1:8080` / unset | set in Spotify's localStorage, see above |

Environment variables win over `.env`. `.env` is read from the directory you start matcha in.

---

## Requirements

Debian packages wherever one exists. Every item marked ✗ has no Debian package.

**To build**

| What | Debian package | Used for |
|---|---|---|
| Python 3.13 | `python3` | system Python. No virtualenvs, never `pip install` into it |
| PyInstaller | `python3-pyinstaller` | building `dist/matcha` |
| objcopy | `binutils` | used by PyInstaller |
| Flask, RapidFuzz, Spotipy, Requests, certifi | `python3-flask` `python3-rapidfuzz` `python3-spotipy` `python3-requests` `python3-certifi` | matcha |
| ytmusicapi | ✗ | unpacked into `vendor/` by `python3 scripts/fetch_vendor.py` (a pure-Python wheel from PyPI) |
| Bun ≥ 1.3 | ✗ | building `dist/y-the-md` and `dist/spice-ify.js` |
| `peerjs`, `node-datachannel` | ✗ (npm) | WebRTC for Music Together. Fetched with `cd mt-peer && bun install` (`y-the-md/node_modules` links there) and embedded in `dist/y-the-md` |

**To run**

| What | Package | Needed by |
|---|---|---|
| glibc, zlib, CA certificates | `libc6` `zlib1g` `ca-certificates` (Debian base) | `dist/matcha`, `dist/y-the-md` |
| pear-desktop 3.12 (YouTube Music) | ✗ (`.deb` from its GitHub releases) | the host; API Server plugin enabled; Music Together for Listen Together |
| Spotify desktop + Spicetify | ✗ | every Spotify listener |

`dist/matcha` is built against Debian's packages and `vendor/` only. Anything pip-installed
into `/usr/local` or `~/.local` is deliberately ignored by the build.

---

## More

- [`RUNNING.md`](RUNNING.md): running from source and manual control (`y-the-md --now`,
  `--queue`, …). Partly outdated; the steps above are the tested ones.
- [`STACK.md`](STACK.md): how the pieces fit, every API route, known gaps.
- [`DEPENDENCIES.md`](DEPENDENCIES.md): installing things in detail, including pear-desktop.
- [`AGENTS.md`](AGENTS.md): design rules and the constraints behind them.
- [`TODO.md`](TODO.md): what's next.
