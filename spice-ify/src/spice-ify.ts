/**
 * spice-ify — Spicetify extension for the YouTube Music <-> Spotify bridge.
 *
 * Runs inside the Spotify desktop client, which makes it the highest-capability
 * Spotify tier available and, critically, the only one that works without
 * Premium on the app owner:
 *
 *   - **search** runs against the user's already-authenticated client, so it
 *     sidesteps the Web API quota regime entirely (AGENTS.md constraint 3);
 *   - **queue, seek and transport** drive the local player directly, so they do
 *     not need `user-modify-playback-state` or an OAuth slot.
 *
 * An extension cannot listen on a port, so this polls matcha for work and posts
 * results back. See matcha/relay.py for the other half.
 *
 * Build: bun build src/spice-ify.ts --format iife --outfile dist/spice-ify.js
 * Install: copy dist/spice-ify.js into Spicetify's Extensions directory then
 *          spicetify config extensions spice-ify.js && spicetify apply
 *
 * Settings live in Spotify's localStorage, so a listener on another machine
 * can point at a shared matcha without rebuilding. In DevTools (Ctrl+Shift+I):
 *
 *   localStorage.setItem('spice-ify:matcha-url', 'https://hub.example:8080')
 *   localStorage.setItem('spice-ify:matcha-token', '<MATCHA_TOKEN>')
 *
 * then reload Spotify (Ctrl+Shift+R). Both default to a local, open matcha.
 */

declare const Spicetify: any;

function setting(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

const MATCHA_URL = setting('spice-ify:matcha-url', 'http://127.0.0.1:8080').replace(/\/$/, '');
const MATCHA_TOKEN = setting('spice-ify:matcha-token', '');

/**
 * Stable across reloads. A fresh id per load left a ghost client in matcha
 * after every Spotify restart until it timed out, and made this listener look
 * like a newcomer to the engine each time.
 */
const CLIENT_ID = (() => {
  const key = 'spice-ify:client-id';
  const existing = setting(key, '');
  if (existing) return existing;
  const id = `spice-ify-${Math.random().toString(36).slice(2, 8)}`;
  try {
    localStorage.setItem(key, id);
  } catch {
    /* private storage unavailable: a per-load id still works */
  }
  return id;
})();

const STATE_INTERVAL_MS = 1000;
const POLL_INTERVAL_MS = 1000;
const QUEUE_INTERVAL_MS = 1000;

type PendingRequest = { id: string; kind: string; payload: any };

function log(...args: unknown[]): void {
  console.log('[spice-ify]', ...args);
}

function notify(message: string, isError = false): void {
  try {
    Spicetify.showNotification?.(message, isError);
  } catch {
    /* notifications are a courtesy; the console line below is the record */
  }
  log(message);
}

class HttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: any,
  ) {
    super(`${path} -> ${status}${body?.error ? `: ${body.error}` : ''}`);
  }
}

async function post(path: string, body: unknown): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (MATCHA_TOKEN) headers.Authorization = `Bearer ${MATCHA_TOKEN}`;
  const res = await fetch(`${MATCHA_URL}/api/v1${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(path, res.status, await res.json().catch(() => null));
  return res.json();
}

// --------------------------------------------------------------------------
// Reading local playback
// --------------------------------------------------------------------------

function currentState() {
  const data = Spicetify.Player?.data;
  const item = data?.item ?? data?.track;
  if (!item) return { paused: true };

  const meta = item.metadata ?? {};
  const artists: string[] = [];
  // Spotify exposes collaborators as artist_name, artist_name:1, :2, ...
  if (meta.artist_name) artists.push(meta.artist_name);
  for (let i = 1; i < 8; i++) {
    const extra = meta[`artist_name:${i}`];
    if (extra) artists.push(extra);
  }

  return {
    track_id: item.uri,
    title: meta.title ?? item.name,
    artists,
    album: meta.album_title,
    duration_ms: Number(meta.duration) || item.duration?.milliseconds,
    position_ms: Spicetify.Player.getProgress?.(),
    paused: !Spicetify.Player.isPlaying?.(),
  };
}

// --------------------------------------------------------------------------
// Handling work from matcha
// --------------------------------------------------------------------------

/**
 * Search the catalogue through the logged-in client.
 *
 * This is the whole reason spice-ify matters: it returns the same data the Web
 * API would, without a dev app, an OAuth slot, or owner Premium.
 */
type OutTrack = {
  id: string | null;
  uri: string;
  title: string;
  artists: string[];
  album: string | null;
  duration_ms: number | null;
  isrc: string | null;
};

/** uri "spotify:track:ID" -> "ID" */
function idFromUri(uri: string | undefined): string | null {
  if (!uri) return null;
  const parts = uri.split(':');
  return parts.length === 3 ? parts[2] : null;
}

/** Accept either a bare track id or a full URI; always return a URI. */
function toUri(value: string): string {
  return value.startsWith('spotify:') ? value : `spotify:track:${value}`;
}

/**
 * Extract an HTTP status from whatever CosmosAsync / GraphQL threw.
 *
 * These errors put the status in different, often non-enumerable places, so an
 * opaque `HttpResponseError` needs digging. Knowing 400 vs 429 vs 401 is the
 * whole difference between "stale query", "rate limited" and "bad token".
 */
function httpStatus(e: any): number | undefined {
  return (
    e?.status ??
    e?.statusCode ??
    e?.response?.status ??
    e?.code ??
    (typeof e?.message === 'string' && /(\b\d{3}\b)/.test(e.message)
      ? Number(RegExp.$1)
      : undefined)
  );
}

type SearchOutcome = { tracks: OutTrack[] } | { error: string; status?: number };

/**
 * REST search via the logged-in client's token.
 *
 * This is a *different quota* from matcha's dev-app credentials (which 403 when
 * the app owner is not Premium): CosmosAsync signs the request with the user's
 * own session, so it is the yt-dlp model — the real client's own access. It is
 * the primary path because it is the most stable across Spotify versions.
 */
async function restSearch(query: string, limit: number): Promise<SearchOutcome> {
  const url =
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`;
  try {
    const res = await Spicetify.CosmosAsync.get(url);
    // CosmosAsync sometimes resolves with an error-shaped body instead of throwing.
    if (res?.error || res?.code >= 400) {
      return { error: `rest body ${res.code ?? ''} ${res.message ?? res.error ?? ''}`.trim(), status: res.code };
    }
    const items = res?.tracks?.items;
    if (!Array.isArray(items)) {
      return { error: `rest: no items array; keys=${Object.keys(res ?? {})}` };
    }
    return {
      tracks: items.map((t: any) => ({
        id: t.uri, // URI as id — matches state reports and playTrack
        uri: t.uri,
        title: t.name,
        artists: (t.artists ?? []).map((a: any) => a.name),
        album: t.album?.name ?? null,
        duration_ms: t.duration_ms ?? null,
        isrc: t.external_ids?.isrc ?? null,
      })),
    };
  } catch (err: any) {
    return { error: `rest threw: ${err?.message ?? err}`, status: httpStatus(err) };
  }
}

/**
 * GraphQL `searchModalResults` — the query the Spotify search modal uses.
 *
 * Secondary to REST because the persisted-query hash is version-specific and can
 * go stale (→ 400 HttpResponseError). Uses the full known variable signature;
 * an incomplete set is a common cause of a 400 here.
 */
async function graphqlSearch(query: string, limit: number): Promise<SearchOutcome> {
  const GQL = Spicetify?.GraphQL;
  const defName = ['searchModalResults', 'searchDesktop', 'searchTracks'].find(
    (n) => GQL?.Definitions?.[n],
  );
  if (!GQL?.Request || !defName) {
    return { error: 'graphql: no search definition available' };
  }

  // Full variable signature — the search-modal query rejects (400) on a partial
  // set rather than defaulting the missing flags.
  const variables = {
    searchTerm: query,
    offset: 0,
    limit,
    numberOfTopResults: limit,
    includeAudiobooks: true,
    includeArtistHasConcertsField: false,
    includePreReleases: true,
    includeLocalConcertsField: false,
    includeAuthors: false,
  };

  let res: any;
  try {
    res = await GQL.Request(GQL.Definitions[defName], variables);
  } catch (err: any) {
    return { error: `graphql ${defName} threw`, status: httpStatus(err) };
  }
  if (res?.errors) {
    return { error: `graphql body.errors=${JSON.stringify(res.errors).slice(0, 200)}` };
  }

  // The exact path to tracks under searchV2 varies by version (tracksV2.items,
  // topResultsV2.itemsV2, ...). Rather than guess, walk the response and collect
  // every node that looks like a track: a `spotify:track:` uri plus a name. This
  // is version-proof and cannot break on a path rename.
  const out: OutTrack[] = [];
  const seen = new Set<string>();
  const visit = (node: any, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) {
      for (const el of node) visit(el, depth + 1);
      return;
    }
    const uri: string | undefined = node.uri;
    if (typeof uri === 'string' && uri.startsWith('spotify:track:') && node.name && !seen.has(uri)) {
      seen.add(uri);
      out.push({
        id: uri,
        uri,
        title: node.name,
        artists: (node.artists?.items ?? node.artists ?? [])
          .map((a: any) => a?.profile?.name ?? a?.name)
          .filter(Boolean),
        album: node.albumOfTrack?.name ?? node.album?.name ?? null,
        duration_ms: node.duration?.totalMilliseconds ?? node.duration_ms ?? null,
        isrc: null,
      });
    }
    for (const key of Object.keys(node)) visit(node[key], depth + 1);
  };
  visit(res.data, 0);

  if (!out.length) {
    return {
      error: `graphql ok but no track nodes; searchV2 keys=${Object.keys(
        res?.data?.searchV2 ?? res?.data ?? {},
      )}`,
    };
  }
  return { tracks: out.slice(0, limit) };
}

async function handleSearch(payload: any) {
  const query: string = payload.query ?? '';
  const limit: number = payload.limit ?? 8;

  // Try every door; whichever returns tracks wins. REST first (most stable),
  // then GraphQL. Record each outcome so a total failure is diagnosable in one
  // log line instead of an opaque throw.
  const attempts: Record<string, string> = {};

  for (const [name, fn] of [
    ['rest', restSearch],
    ['graphql', graphqlSearch],
  ] as const) {
    const outcome = await fn(query, limit);
    if ('tracks' in outcome) {
      if (outcome.tracks.length) return { tracks: outcome.tracks, via: name };
      attempts[name] = 'empty (0 results)';
    } else {
      attempts[name] = `${outcome.error}${outcome.status ? ` [status ${outcome.status}]` : ''}`;
    }
  }

  return {
    tracks: [],
    debug: {
      query,
      attempts,
      hint:
        'status 429 = rate limited (wait); 400 = stale query/vars; 401/403 = token. ' +
        'If REST is 429 but you listen normally, it will recover — matcha caches + backs off.',
    },
  };
}

async function handleCommand(payload: any) {
  const { action, value } = payload;

  switch (action) {
    case 'play':
      Spicetify.Player.play();
      return { ok: true };
    case 'pause':
      Spicetify.Player.pause();
      return { ok: true };
    case 'next':
      Spicetify.Player.next();
      return { ok: true };
    case 'previous':
      Spicetify.Player.back();
      return { ok: true };
    case 'seek':
      // matcha speaks milliseconds throughout; so does Spicetify here.
      Spicetify.Player.seek(Number(value));
      return { ok: true };
    case 'queue':
      // Ours, not the listener's: the queue watcher must not send it back.
      expectOwnAdd(toUri(value));
      try {
        await Spicetify.Platform.PlayerAPI.addToQueue([{ uri: toUri(value) }]);
      } catch (err) {
        consumeOwnAdd(toUri(value)); // never queued, so no echo will come
        throw err;
      }
      return { ok: true };
    case 'playTrack':
      await Spicetify.Platform.PlayerAPI.play({ uri: toUri(value) }, {}, {});
      return { ok: true };
    default:
      return { ok: false, error: `unknown action '${action}'` };
  }
}

async function handle(request: PendingRequest) {
  try {
    const result =
      request.kind === 'search'
        ? await handleSearch(request.payload)
        : await handleCommand(request.payload);
    await post('/spotify/result', { id: request.id, result });
  } catch (err) {
    await post('/spotify/result', {
      id: request.id,
      result: { ok: false, error: String((err as Error).message ?? err) },
    }).catch(() => {});
  }
}

// --------------------------------------------------------------------------
// Forwarding the listener's queue adds
// --------------------------------------------------------------------------
//
// The session queue is the leader's (YouTube Music by default): followers are
// driven onto the leader's track every tick, so a track left in *this* queue
// would either never play or start early and be yanked straight back. So a
// track the listener queues here is handed to matcha, which puts it into the
// leader's queue, and is removed from this one only once that is confirmed --
// it then plays for everyone, here included, when the session reaches it.
//
// Only Spotify's own "Next in queue" counts as a human add. Autoplay and the
// playing context sit in `nextUp`, so they can never be mistaken for one.

type QueuedTrack = {
  uid: string;
  uri: string;
  title: string;
  artists: string[];
  album: string | null;
  duration_ms: number | null;
};

/** Give up on a track after this many failed hand-offs (~1 min at 10s). */
const MAX_FORWARD_ATTEMPTS = 6;
const RETRY_AFTER_MS = 10_000;

/** uids already accounted for: forwarded, ignored, or present at startup. */
const seen = new Set<string>();
let baselined = false;
/** Waiting to be handed to matcha, in the order the listener queued them. */
const outbox: { track: QueuedTrack; attempts: number; retryAt: number }[] = [];
let forwarding = false;
/** URIs we queued on matcha's behalf, oldest first, with when we queued them. */
const ownAdds: { uri: string; at: number }[] = [];
/**
 * An own add shows up in the queue within a second or two. One that never
 * does (it landed before the watcher's baseline, or Spotify dropped it) must
 * not hide a later, genuine add of the same track forever.
 */
const OWN_ADD_TTL_MS = 30_000;

function expectOwnAdd(uri: string): void {
  ownAdds.push({ uri, at: Date.now() });
}

function consumeOwnAdd(uri: string): boolean {
  const cutoff = Date.now() - OWN_ADD_TTL_MS;
  while (ownAdds.length && ownAdds[0].at < cutoff) ownAdds.shift();
  const i = ownAdds.findIndex((a) => a.uri === uri);
  if (i < 0) return false;
  ownAdds.splice(i, 1);
  return true;
}

/** URIs this client handed to matcha, with when -- see the `duplicate` case below. */
const forwarded = new Map<string, number>();
const FORWARDED_MEMORY_MS = 120_000;

/**
 * Spotify's queue controller. Checked against client 1.2.x: `getQueue()`
 * returns `{ current, queued, nextUp }`, where `queued` is exactly the
 * listener's "Next in queue".
 */
function queueController(): any {
  return Spicetify.Platform?.PlayerAPI?._queue ?? Spicetify.Player?.origin?._queue;
}

function userQueued(): QueuedTrack[] | undefined {
  const state = queueController()?.getQueue?.();
  if (!state || !Array.isArray(state.queued)) return undefined;

  return state.queued
    .filter((t: any) => t?.uid && typeof t.uri === 'string' && t.uri.startsWith('spotify:track:'))
    .map((t: any) => ({
      uid: t.uid,
      uri: t.uri,
      title: t.name || t.metadata?.title || '',
      artists: (t.artists ?? []).map((a: any) => a?.name).filter(Boolean),
      album: t.album?.name ?? t.metadata?.album_title ?? null,
      duration_ms:
        (typeof t.duration === 'number' ? t.duration : t.duration?.milliseconds) ??
        (Number(t.metadata?.duration) || null),
    }));
}

async function removeLocally(track: QueuedTrack): Promise<void> {
  try {
    await queueController().removeFromQueue([{ uri: track.uri, uid: track.uid }]);
  } catch (err) {
    notify(
      `"${track.title}" is in the session queue but also still in yours — remove it here by hand`,
      true,
    );
    log('removeFromQueue failed', err);
  }
}

async function forwardOutbox(): Promise<void> {
  if (forwarding) return;
  forwarding = true;
  try {
    while (outbox.length && outbox[0].retryAt <= Date.now()) {
      const entry = outbox[0];
      const { track } = entry;

      // Played or removed by the listener meanwhile: nothing left to hand off.
      // (Unreadable for a moment is not the same as gone: try again next tick.)
      const queuedNow = userQueued();
      if (!queuedNow) return;
      if (!queuedNow.some((t) => t.uid === track.uid)) {
        outbox.shift();
        continue;
      }

      let result: any;
      try {
        result = await post('/queue/add', {
          client_id: CLIENT_ID,
          platform: 'spotify',
          track: {
            id: track.uri,
            title: track.title,
            artists: track.artists,
            album: track.album,
            duration_ms: track.duration_ms,
          },
        });
      } catch (err) {
        // 400 will not improve with retries; unreachable / 503 may.
        const permanent = err instanceof HttpError && err.status === 400;
        entry.attempts += 1;
        if (permanent || entry.attempts >= MAX_FORWARD_ATTEMPTS) {
          outbox.shift();
          notify(`Couldn't add "${track.title}" to the session: ${(err as Error).message}`, true);
        } else {
          entry.retryAt = Date.now() + RETRY_AFTER_MS;
          log(`queue hand-off failed (${(err as Error).message}); retrying "${track.title}"`);
        }
        return; // keep order: nothing behind it goes first
      }

      outbox.shift();
      const sentBefore = forwarded.get(track.uri);
      if (result?.queued && result.duplicate && sentBefore && Date.now() - sentBefore < FORWARDED_MEMORY_MS) {
        // We forwarded this track already, so this new entry is the session's
        // own copy (e.g. this client shares a Jam with the leader): keep it.
        // Removing it would delete the track from the session altogether.
      } else if (result?.queued) {
        forwarded.set(track.uri, Date.now());
        for (const [uri, at] of forwarded) {
          if (Date.now() - at > FORWARDED_MEMORY_MS) forwarded.delete(uri);
        }
        await removeLocally(track);
        notify(
          result.duplicate
            ? `Already queued for everyone: ${track.title}`
            : `Queued for everyone: ${track.title}`,
        );
      } else if (result?.is_leader) {
        // This client leads, so its own queue already is the session queue.
      } else {
        notify(`"${track.title}" stays in your queue only: ${result?.reason ?? 'not accepted'}`, true);
      }
    }
  } finally {
    forwarding = false;
  }
}

function watchQueue(): void {
  if (!reachable) return;
  const queued = userQueued();
  if (!queued) return;

  // Whatever was queued before we connected predates the session; leave it.
  if (!baselined) {
    for (const t of queued) seen.add(t.uid);
    baselined = true;
    return;
  }

  for (const t of queued) {
    if (seen.has(t.uid)) continue;
    seen.add(t.uid);
    if (consumeOwnAdd(t.uri)) continue;
    outbox.push({ track: t, attempts: 0, retryAt: 0 });
  }

  // Forget uids that left the queue, so `seen` cannot grow without bound.
  const present = new Set(queued.map((t) => t.uid));
  for (const uid of seen) if (!present.has(uid)) seen.delete(uid);

  void forwardOutbox();
}

// --------------------------------------------------------------------------
// Loops
// --------------------------------------------------------------------------

let reachable = false;

async function pushState() {
  try {
    await post('/spotify/state', { client_id: CLIENT_ID, state: currentState() });
    if (!reachable) {
      reachable = true;
      log('connected to matcha');
    }
  } catch {
    if (reachable) {
      reachable = false;
      log('matcha unreachable — retrying');
    }
  }
}

async function pollWork() {
  if (!reachable) return;
  try {
    const { requests } = await post('/spotify/pending', {
      limit: 5,
      client_id: CLIENT_ID,
    });
    for (const request of requests ?? []) await handle(request);
  } catch {
    /* next tick will retry */
  }
}

async function main() {
  // Spicetify injects asynchronously; wait rather than racing it.
  while (!Spicetify?.Player?.data || !Spicetify?.CosmosAsync) {
    await new Promise((r) => setTimeout(r, 300));
  }

  log(`starting as ${CLIENT_ID} -> ${MATCHA_URL}${MATCHA_TOKEN ? ' (token set)' : ''}`);
  if (!queueController()?.getQueue) {
    log('queue controller not found; queue adds will stay local to this client');
  }
  setInterval(pushState, STATE_INTERVAL_MS);
  setInterval(pollWork, POLL_INTERVAL_MS);
  setInterval(watchQueue, QUEUE_INTERVAL_MS);
  await pushState();
}

main();
