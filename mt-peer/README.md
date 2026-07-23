# mt-peer

Joins a pear-desktop **Music Together** session as a guest peer.

## What this is not

**Not a server.** Music Together is peer-to-peer: a pear-desktop instance *hosts*
the session, others join as *guests*, and there is no server component anywhere in
the design. `mt-peer` is simply another guest.

The one third party involved is **signalling** — PeerJS's public broker introduces
the two peers, after which media/data flows directly P2P (with TURN relay as
fallback). We cannot self-host that broker without patching pear-desktop, which
hardcodes it.

The only server this project runs is `server/` (matcha + relay), which has nothing
to do with Music Together's transport.

## Why a guest peer instead of the api-server plugin

One guest connection observes and controls the **whole shared session**, so it
serves every YouTube Music listener at once — no per-participant setup. It also
carries the queue (`SYNC_QUEUE`, `ADD_SONGS`, `MOVE_SONG`, …), which MPRIS cannot
do at all. See AGENTS.md constraint 7.

## Setup

```bash
cd mt-peer
bun install
```

Two dependencies: `peerjs` (the client library pear-desktop also uses) and
`node-datachannel` (WebRTC for a non-browser runtime — the project's only native
dependency, loaded via N-API).

TypeScript runs directly under Bun; there is no build step.

## Use

```bash
bun run probe                 # check the runtime can do WebRTC data channels
bun run join <host-peer-id>   # join a session and log everything it sends
```

Get the host id from pear-desktop: **Music Together → host a session → copy id**.
The plugin puts the raw PeerJS id on your clipboard; paste it straight in.

## What the spike is answering

1. **Can a non-pear-desktop peer join at all?** Everything downstream depends on it.
2. **What `Permission` does a guest get by default?** `host-only` means we can only
   observe; `playlist` or `all` means we can write the queue. This decides whether
   YouTube Music can be a full sync participant or a read-only one.

## Protocol stability

The wire protocol is internal to the plugin with no compatibility promise. It is
pinned in `src/protocol.ts` (`TESTED_AGAINST`) and unknown event types are logged
loudly rather than ignored, so drift after a pear-desktop update is obvious rather
than silent.
