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
 * Build: bun build src/spice-ify.ts --outfile dist/spice-ify.js
 * Install: copy dist/spice-ify.js into ~/.spicetify/Extensions/ then
 *          spicetify config extensions spice-ify.js && spicetify apply
 */

declare const Spicetify: any;

const MATCHA_URL = 'http://127.0.0.1:8080';
const CLIENT_ID = `spice-ify-${Math.random().toString(36).slice(2, 8)}`;

const STATE_INTERVAL_MS = 1000;
const POLL_INTERVAL_MS = 1000;

type PendingRequest = { id: string; kind: string; payload: any };

function log(...args: unknown[]): void {
  console.log('[spice-ify]', ...args);
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${MATCHA_URL}/api/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
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
      await Spicetify.Platform.PlayerAPI.addToQueue([{ uri: toUri(value) }]);
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

  log(`starting as ${CLIENT_ID}`);
  setInterval(pushState, STATE_INTERVAL_MS);
  setInterval(pollWork, POLL_INTERVAL_MS);
  await pushState();
}

main();
