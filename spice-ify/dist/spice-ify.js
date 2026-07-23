// spice-ify/src/spice-ify.ts
var MATCHA_URL = "http://127.0.0.1:8080";
var CLIENT_ID = `spice-ify-${Math.random().toString(36).slice(2, 8)}`;
var STATE_INTERVAL_MS = 1000;
var POLL_INTERVAL_MS = 1000;
function log(...args) {
  console.log("[spice-ify]", ...args);
}
async function post(path, body) {
  const res = await fetch(`${MATCHA_URL}/api/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok)
    throw new Error(`${path} -> ${res.status}`);
  return res.json();
}
function currentState() {
  const data = Spicetify.Player?.data;
  const item = data?.item ?? data?.track;
  if (!item)
    return { paused: true };
  const meta = item.metadata ?? {};
  const artists = [];
  if (meta.artist_name)
    artists.push(meta.artist_name);
  for (let i = 1;i < 8; i++) {
    const extra = meta[`artist_name:${i}`];
    if (extra)
      artists.push(extra);
  }
  return {
    track_id: item.uri,
    title: meta.title ?? item.name,
    artists,
    album: meta.album_title,
    duration_ms: Number(meta.duration) || item.duration?.milliseconds,
    position_ms: Spicetify.Player.getProgress?.(),
    paused: !Spicetify.Player.isPlaying?.()
  };
}
function toUri(value) {
  return value.startsWith("spotify:") ? value : `spotify:track:${value}`;
}
function httpStatus(e) {
  return e?.status ?? e?.statusCode ?? e?.response?.status ?? e?.code ?? (typeof e?.message === "string" && /(\b\d{3}\b)/.test(e.message) ? Number(RegExp.$1) : undefined);
}
async function restSearch(query, limit) {
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`;
  try {
    const res = await Spicetify.CosmosAsync.get(url);
    if (res?.error || res?.code >= 400) {
      return { error: `rest body ${res.code ?? ""} ${res.message ?? res.error ?? ""}`.trim(), status: res.code };
    }
    const items = res?.tracks?.items;
    if (!Array.isArray(items)) {
      return { error: `rest: no items array; keys=${Object.keys(res ?? {})}` };
    }
    return {
      tracks: items.map((t) => ({
        id: t.uri,
        uri: t.uri,
        title: t.name,
        artists: (t.artists ?? []).map((a) => a.name),
        album: t.album?.name ?? null,
        duration_ms: t.duration_ms ?? null,
        isrc: t.external_ids?.isrc ?? null
      }))
    };
  } catch (err) {
    return { error: `rest threw: ${err?.message ?? err}`, status: httpStatus(err) };
  }
}
async function graphqlSearch(query, limit) {
  const GQL = Spicetify?.GraphQL;
  const defName = ["searchModalResults", "searchDesktop", "searchTracks"].find((n) => GQL?.Definitions?.[n]);
  if (!GQL?.Request || !defName) {
    return { error: "graphql: no search definition available" };
  }
  const variables = {
    searchTerm: query,
    offset: 0,
    limit,
    numberOfTopResults: limit,
    includeAudiobooks: true,
    includeArtistHasConcertsField: false,
    includePreReleases: true,
    includeLocalConcertsField: false,
    includeAuthors: false
  };
  let res;
  try {
    res = await GQL.Request(GQL.Definitions[defName], variables);
  } catch (err) {
    return { error: `graphql ${defName} threw`, status: httpStatus(err) };
  }
  if (res?.errors) {
    return { error: `graphql body.errors=${JSON.stringify(res.errors).slice(0, 200)}` };
  }
  const out = [];
  const seen = new Set;
  const visit = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 8)
      return;
    if (Array.isArray(node)) {
      for (const el of node)
        visit(el, depth + 1);
      return;
    }
    const uri = node.uri;
    if (typeof uri === "string" && uri.startsWith("spotify:track:") && node.name && !seen.has(uri)) {
      seen.add(uri);
      out.push({
        id: uri,
        uri,
        title: node.name,
        artists: (node.artists?.items ?? node.artists ?? []).map((a) => a?.profile?.name ?? a?.name).filter(Boolean),
        album: node.albumOfTrack?.name ?? node.album?.name ?? null,
        duration_ms: node.duration?.totalMilliseconds ?? node.duration_ms ?? null,
        isrc: null
      });
    }
    for (const key of Object.keys(node))
      visit(node[key], depth + 1);
  };
  visit(res.data, 0);
  if (!out.length) {
    return {
      error: `graphql ok but no track nodes; searchV2 keys=${Object.keys(res?.data?.searchV2 ?? res?.data ?? {})}`
    };
  }
  return { tracks: out.slice(0, limit) };
}
async function handleSearch(payload) {
  const query = payload.query ?? "";
  const limit = payload.limit ?? 8;
  const attempts = {};
  for (const [name, fn] of [
    ["rest", restSearch],
    ["graphql", graphqlSearch]
  ]) {
    const outcome = await fn(query, limit);
    if ("tracks" in outcome) {
      if (outcome.tracks.length)
        return { tracks: outcome.tracks, via: name };
      attempts[name] = "empty (0 results)";
    } else {
      attempts[name] = `${outcome.error}${outcome.status ? ` [status ${outcome.status}]` : ""}`;
    }
  }
  return {
    tracks: [],
    debug: {
      query,
      attempts,
      hint: "status 429 = rate limited (wait); 400 = stale query/vars; 401/403 = token. " + "If REST is 429 but you listen normally, it will recover — matcha caches + backs off."
    }
  };
}
async function handleCommand(payload) {
  const { action, value } = payload;
  switch (action) {
    case "play":
      Spicetify.Player.play();
      return { ok: true };
    case "pause":
      Spicetify.Player.pause();
      return { ok: true };
    case "next":
      Spicetify.Player.next();
      return { ok: true };
    case "previous":
      Spicetify.Player.back();
      return { ok: true };
    case "seek":
      Spicetify.Player.seek(Number(value));
      return { ok: true };
    case "queue":
      await Spicetify.Platform.PlayerAPI.addToQueue([{ uri: toUri(value) }]);
      return { ok: true };
    case "playTrack":
      await Spicetify.Platform.PlayerAPI.play({ uri: toUri(value) }, {}, {});
      return { ok: true };
    default:
      return { ok: false, error: `unknown action '${action}'` };
  }
}
async function handle(request) {
  try {
    const result = request.kind === "search" ? await handleSearch(request.payload) : await handleCommand(request.payload);
    await post("/spotify/result", { id: request.id, result });
  } catch (err) {
    await post("/spotify/result", {
      id: request.id,
      result: { ok: false, error: String(err.message ?? err) }
    }).catch(() => {});
  }
}
var reachable = false;
async function pushState() {
  try {
    await post("/spotify/state", { client_id: CLIENT_ID, state: currentState() });
    if (!reachable) {
      reachable = true;
      log("connected to matcha");
    }
  } catch {
    if (reachable) {
      reachable = false;
      log("matcha unreachable — retrying");
    }
  }
}
async function pollWork() {
  if (!reachable)
    return;
  try {
    const { requests } = await post("/spotify/pending", {
      limit: 5,
      client_id: CLIENT_ID
    });
    for (const request of requests ?? [])
      await handle(request);
  } catch {}
}
async function main() {
  while (!Spicetify?.Player?.data || !Spicetify?.CosmosAsync) {
    await new Promise((r) => setTimeout(r, 300));
  }
  log(`starting as ${CLIENT_ID}`);
  setInterval(pushState, STATE_INTERVAL_MS);
  setInterval(pollWork, POLL_INTERVAL_MS);
  await pushState();
}
main();
