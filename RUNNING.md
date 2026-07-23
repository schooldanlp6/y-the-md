# Running it

**Two terminals, not three.** `y-the-md` has Music Together built in, so `mt-peer/`
is only a debugging tool — you do not run it as part of the system.

If anything is off, run this first; it walks the whole chain and names the broken link:

```bash
python3 scripts/doctor.py
```

---

## Before you start

| | What | Check |
|---|---|---|
| 1 | **pear-desktop running** | the YouTube Music app is open |
| 2 | **API Server plugin on** | Plugins → API Server → enabled, `hostname` = `127.0.0.1` |
| 3 | **Spotify running with spice-ify** | see "Spotify side" below |

---

## Terminal 1 — matcha (matching + relay + sync engine)

```bash
cd ~/Repos/youtube-music-listentogether-and-spotify-jam
SYNC_CROSSFADE_MS=6000 python3 -m matcha.main
```

Binds `127.0.0.1:8080`. **Sync is on by default** — disable with `SYNC=0` if you ever want
it to observe without acting. Toggle live without restarting:

```bash
curl -X POST -H 'Content-Type: application/json' -d '{"enabled":false}' \
  localhost:8080/api/v1/sync
```

`SYNC_CROSSFADE_MS` must match every client's crossfade and is set by hand. Yours is 6s → `6000`.
Leader defaults to `ytm`; override with `SYNC_LEADER=spotify`.

## Terminal 2 — y-the-md (YouTube Music client)

```bash
cd ~/Repos/youtube-music-listentogether-and-spotify-jam/y-the-md
bun run sync
```

Reports state ~1 Hz and obeys commands. **Takes no arguments** — the api-server hook
needs no session id.

To also reach *other* listeners, join a Music Together session by giving it the host id.
Host in pear-desktop, copy the id, then:

```bash
YTMD_MT_HOST_ID=<host-peer-id> bun run sync
YTMD_MT_HOST_ID=clipboard      bun run sync   # needs: sudo apt install wl-clipboard
```

There is **no autojoin** — the id is generated per session and never written to disk,
so it has to be handed over each time.

## Spotify side — no terminal

spice-ify loads inside Spotify itself. Install once:

```bash
cd spice-ify && bun run install-ext
spicetify config extensions spice-ify.js && spicetify apply
```

Then just start Spotify. To check it is alive: **Ctrl+Shift+I** in Spotify, Console tab,
look for `[spice-ify]`.

| What you see | Meaning |
|---|---|
| `starting as spice-ify-xxxxxx` then `connected to matcha` | working |
| `matcha unreachable` | loaded, but cannot reach `127.0.0.1:8080` — start matcha, or CSP is blocking it |
| nothing at all | not loaded — re-run `spicetify config extensions` + `spicetify apply` |

---

## Confirming it works

```bash
python3 scripts/doctor.py
```

You want **two clients, on two platforms**:

```
[  OK ]   y-the-md-xxxxx  — platform=ytm     track='...'
[  OK ]   spice-ify-xxxxx — platform=spotify track='...'
```

**Sync needs two platforms, not two processes.** With only YouTube Music reporting, the
engine correctly does nothing — there is no follower to drive.

Watch what it decides without letting it act:

```bash
curl -X POST localhost:8080/api/v1/sync/tick    # one tick, shows the actions
curl -s localhost:8080/api/v1/sync              # status + last actions
```

---

## Driving it by hand

Works without the engine, and routes to the best available hook automatically:

```bash
cd y-the-md
bun run src/main.ts --status                # which hook serves which capability
bun run src/main.ts --now                   # current track
bun run src/main.ts --queue                 # upcoming
bun run src/main.ts --play | --pause | --skip | --back
bun run src/main.ts --seek 30
bun run src/main.ts --play-track <videoId>
bun run src/main.ts --enqueue <videoId>
bun run src/main.ts --match                 # resolve current track onto Spotify
```

**Blast radius depends on whether you joined a session.** Without `YTMD_MT_HOST_ID`,
commands go via api-server and affect only this machine. With it, they route to
Music Together first and reach everyone in the session. `--status` shows which.

## Debugging tools (not part of the system)

```bash
cd mt-peer
bun run src/main.ts <host-id>                    # join and log every event
bun run src/main.ts <host-id> --pause
bun run src/main.ts <host-id> --seek 30
bun run src/main.ts <host-id> --next <videoId>
bun run src/main.ts <host-id> --queue-probe <videoId>
```
