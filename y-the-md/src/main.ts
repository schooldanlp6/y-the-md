/**
 * ytmd — YouTube Music client.
 *
 * Three hooks (Music Together, api-server, MPRIS) behind one capability router.
 * Nothing here names a hook directly; it asks for capabilities.
 */
import { ApiServerEndpoint } from './endpoints/api-server.ts';
import { MusicTogetherEndpoint } from './endpoints/music-together.ts';
import type { Endpoint } from './endpoints/types.ts';
import { loadConfig } from './config.ts';
import { Router } from './router.ts';
import type { EndpointName } from './capabilities.ts';
import { MatchaClient, MatchaError } from './matcha.ts';
import { nowPlayingToMatcha, queueItemToMatcha } from './translate.ts';
import { SyncClient } from './sync.ts';
import { resolveHostId } from './hostid.ts';

function matchaClient(): MatchaClient {
  return new MatchaClient(
    process.env.MATCHA_URL ?? 'http://127.0.0.1:8080',
    process.env.MATCHA_TOKEN,
  );
}

async function build(): Promise<{ router: Router; endpoints: Map<EndpointName, Endpoint> }> {
  const config = loadConfig();

  const endpoints = new Map<EndpointName, Endpoint>();
  endpoints.set('api-server', new ApiServerEndpoint(config.apiServer));

  // Only join a session when a host id was supplied; without one the other
  // hooks still work and the router degrades on its own.
  let hostId: string | undefined;
  try {
    hostId = await resolveHostId(process.env.YTMD_MT_HOST_ID ?? config.musicTogether.hostId);
  } catch (err) {
    console.error(`  ! music-together: ${(err as Error).message}`);
  }
  endpoints.set(
    'music-together',
    new MusicTogetherEndpoint(hostId, {
      id: `bridge-${Math.random().toString(36).slice(2, 10)}`,
      handleId: 'ytm-spotify-bridge',
      name: 'Bridge',
      thumbnail: '',
    }),
  );
  // mpris is wired next; the router already handles its absence.

  const router = new Router(config, endpoints);
  await router.probe();

  for (const endpoint of endpoints.values()) {
    try {
      await endpoint.connect?.();
    } catch (err) {
      console.error(`  ! ${endpoint.name}: ${(err as Error).message}`);
    }
  }
  await router.probe();

  return { router, endpoints };
}

async function status(): Promise<void> {
  const { router, endpoints } = await build();

  console.log('endpoints:');
  const availability = await router.probe();
  for (const name of endpoints.keys()) {
    console.log(`  ${name.padEnd(15)} ${availability.get(name) ? 'up' : 'DOWN'}`);
  }

  console.log('\ncapability routing:');
  for (const line of router.describe()) console.log(line);
}

async function now(): Promise<void> {
  const { router } = await build();
  const song = await router.invoke('metadata', (e) => e.nowPlaying!());
  if (!song) return console.log('nothing playing');
  console.log(
    `${song.title} — ${song.artist}` +
      (song.album ? ` (${song.album})` : '') +
      `\n  videoId ${song.videoId}` +
      `\n  ${Math.round((song.positionMs ?? 0) / 1000)}s / ${Math.round((song.durationMs ?? 0) / 1000)}s` +
      `  ${song.paused ? 'PAUSED' : 'playing'}`,
  );
}

async function showQueue(): Promise<void> {
  const { router } = await build();
  const q = await router.invoke('queueRead', (e) => e.queue!());
  if (!q) return console.log('no queue');

  console.log(`${q.items.length} tracks, autoplay=${q.autoPlaying}`);
  q.items.forEach((it, i) => {
    if (i < 5 || Math.abs(i - (q.currentIndex ?? 0)) < 3 || i >= q.items.length - 2) {
      console.log(`  ${String(i).padStart(3)}${it.current ? '*' : ' '} ${it.title ?? it.videoId}`);
    }
  });
}

/** Resolve the currently playing YouTube Music track onto Spotify via matcha. */
async function match(): Promise<void> {
  const { router } = await build();
  const matcha = matchaClient();

  const health = await matcha.health().catch(() => undefined);
  if (!health) {
    console.error('matcha unreachable — start it with: python3 -m matcha.main');
    process.exit(1);
  }
  console.log(`matcha up, providers: ${JSON.stringify(health.providers)}\n`);

  const song = await router.invoke('metadata', (e) => e.nowPlaying!());
  if (!song) return console.log('nothing playing');

  const track = nowPlayingToMatcha(song);
  if (!track) return console.log('current track has no title — cannot match');

  console.log(`YTM: ${track.title} — ${track.artists.join(', ')} [${track.id}]`);

  try {
    const result = await matcha.match(track, 'ytm', 'spotify');
    if (result.matched && result.track) {
      console.log(
        `Spotify: ${result.track.title} — ${result.track.artists.join(', ')}\n` +
          `  id ${result.target_id}  confidence ${result.confidence}  ` +
          `via ${result.method}${result.cached ? ' (cached)' : ''}`,
      );
    } else {
      console.log(`no match (confidence ${result.confidence ?? 'n/a'})`);
      if (result.rejected) {
        console.log(`  closest: ${result.rejected.title} — ${result.rejected.artists.join(', ')}`);
      }
    }
  } catch (err) {
    if (err instanceof MatchaError && err.providerUnavailable) {
      // Expected while the Spotify Web API is blocked; the wiring is still proven
      // by the request reaching matcha and being answered.
      console.log(`Spotify provider unavailable — ${err.message}`);
      console.log('  (matcha reached and responded; only the upstream provider is down)');
    } else throw err;
  }
}

/** Pre-match the upcoming queue, which is what makes transitions seamless. */
async function matchQueue(): Promise<void> {
  const { router } = await build();
  const matcha = matchaClient();

  const q = await router.invoke('queueRead', (e) => e.queue!());
  if (!q) return console.log('no queue');

  const start = q.currentIndex ?? 0;
  const upcoming = q.items.slice(start + 1, start + 6);
  if (!upcoming.length) return console.log('nothing upcoming');

  console.log(`pre-matching ${upcoming.length} upcoming tracks…\n`);
  const tracks = upcoming.map(queueItemToMatcha);

  try {
    const res = await matcha.matchBatch(tracks, 'ytm', 'spotify');
    console.log(`${res.matched}/${res.count} matched`);
    res.results.forEach((r, i) => {
      const src = tracks[i];
      const dst = r.matched && r.track ? `${r.track.title} — ${r.track.artists.join(', ')}` : 'NO MATCH';
      console.log(`  ${src.title} -> ${dst}`);
    });
  } catch (err) {
    console.log(`batch failed: ${(err as Error).message}`);
  }
}

/** Run as a sync client: report state, obey commands, until interrupted. */
async function syncDaemon(): Promise<void> {
  const { router } = await build();

  const clientId = process.env.YTMD_CLIENT_ID ?? `y-the-md-${Math.random().toString(36).slice(2, 8)}`;
  const matchaUrl = process.env.MATCHA_URL ?? 'http://127.0.0.1:8080';

  const stamp = () => new Date().toISOString().slice(11, 19);
  const client = new SyncClient(router, {
    matchaUrl,
    clientId,
    token: process.env.MATCHA_TOKEN,
    onLog: (m) => console.log(`[${stamp()}] ${m}`),
  });

  console.log(`y-the-md sync client ${clientId}`);
  console.log(`  matcha: ${matchaUrl}`);
  console.log('  reporting state ~1Hz, polling commands 2Hz. Ctrl-C to stop.\n');

  await client.start();

  const shutdown = () => {
    console.log('\nstopping…');
    client.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {}); // run until signalled
}

/** Manual control, for driving a session by hand without the engine. */
async function control(action: string, value?: string): Promise<void> {
  const { router } = await build();

  const run = async () => {
    switch (action) {
      case '--play':
        return router.invoke('transport', (e) => e.play!());
      case '--pause':
        return router.invoke('transport', (e) => e.pause!());
      case '--skip':
        return router.invoke('transport', (e) => e.next!());
      case '--back':
        return router.invoke('transport', (e) => e.previous!());
      case '--seek':
        return router.invoke('seek', (e) => e.seekTo!(Number(value)));
      case '--play-track':
        return router.invoke('queueWrite', (e) => e.playTrack!(String(value)));
      case '--enqueue':
        return router.invoke('queueWrite', (e) => e.enqueue!(String(value), 'next'));
      case '--set-index':
        return router.invoke('queueWrite', (e) => e.setIndex!(Number(value)));
      default:
        throw new Error(`unknown action ${action}`);
    }
  };

  const endpoint = router.resolve(
    action === '--seek' ? 'seek' : action.startsWith('--play-track') || action === '--enqueue' || action === '--set-index' ? 'queueWrite' : 'transport',
  );
  await run();
  console.log(`${action.slice(2)}${value ? ` ${value}` : ''} -> ok (via ${endpoint?.name ?? '?'})`);
}

const CONTROL_ACTIONS = new Set([
  '--play', '--pause', '--skip', '--back', '--seek',
  '--play-track', '--enqueue', '--set-index',
]);

const mode = process.argv[2];

try {
  if (CONTROL_ACTIONS.has(mode)) await control(mode, process.argv[3]);
  else if (mode === '--sync') await syncDaemon();
  else if (mode === '--status') await status();
  else if (mode === '--now') await now();
  else if (mode === '--queue') await showQueue();
  else if (mode === '--match') await match();
  else if (mode === '--match-queue') await matchQueue();
  else {
    console.error(
      'usage:\n' +
        '  bun run src/main.ts --status   endpoint availability + capability routing\n' +
        '  bun run src/main.ts --now      current track\n' +
        '  bun run src/main.ts --queue        upcoming tracks\n' +
        '  bun run src/main.ts --match        resolve current track onto Spotify\n' +
        '  bun run src/main.ts --match-queue  pre-match the next 5 tracks\n' +
        '  bun run src/main.ts --sync         run as a sync client (state + commands)\n' +
        '\nmanual control (routed to the best available hook):\n' +
        '  --play | --pause | --skip | --back\n' +
        '  --seek <seconds>        --play-track <videoId>\n' +
        '  --enqueue <videoId>     --set-index <n>\n\n' +
        'Music Together: YTMD_MT_HOST_ID=<host-peer-id> to join a session, or\n' +
        '                YTMD_MT_HOST_ID=clipboard to read the id pear-desktop copied.\n' +
        '                There is no autojoin: the id is per-session and never persisted.\n' +
        'which is what makes commands reach OTHER listeners rather than just this box.\n\n' +
        'overrides:  YTMD_PREFER_<CAPABILITY>=endpoint[,endpoint]   YTMD_DISABLE=endpoint\n' +
        'matcha:     MATCHA_URL (default http://127.0.0.1:8080)     MATCHA_TOKEN',
    );
    process.exit(1);
  }
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
}
