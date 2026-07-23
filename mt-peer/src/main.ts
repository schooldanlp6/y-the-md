/**
 * CLI spike: join a Music Together session and log everything it sends.
 *
 * Purpose is to answer two questions before any more is built:
 *   1. can a non-pear-desktop peer join at all?
 *   2. what Permission does a guest get by default? (decides whether we can
 *      ever write the queue, or only observe it)
 *
 * Usage:
 *   bun run src/main.ts <host-peer-id>
 *   bun run src/main.ts --probe          # check the runtime, connect to nothing
 */
import { MusicTogetherGuest } from './connection.ts';
import { PlayerState, TESTED_AGAINST, stateName, type Profile } from './protocol.ts';
import { cleanupWebRTC, installWebRTC } from './webrtc.ts';

const GUEST_PROFILE: Profile = {
  id: `bridge-${Math.random().toString(36).slice(2, 10)}`,
  handleId: 'ytm-spotify-bridge',
  name: 'Bridge',
  thumbnail: '',
};

function log(tag: string, detail?: unknown): void {
  const stamp = new Date().toISOString().slice(11, 23);
  if (detail === undefined) console.log(`[${stamp}] ${tag}`);
  else console.log(`[${stamp}] ${tag}`, JSON.stringify(detail));
}

async function probe(): Promise<void> {
  log('probe: installing WebRTC polyfill…');
  await installWebRTC();
  log('probe: RTCPeerConnection present', typeof globalThis.RTCPeerConnection === 'function');
  log('probe: WebSocket present', typeof globalThis.WebSocket === 'function');

  const pc = new globalThis.RTCPeerConnection({});
  const dc = pc.createDataChannel('probe');
  log('probe: data channel created', dc.label);
  pc.close();

  log('probe: OK — runtime can do WebRTC data channels');
  await cleanupWebRTC();

  // node-datachannel keeps native handles alive even after cleanup(), so the
  // event loop never drains on its own. Exit explicitly rather than hang.
  process.exit(0);
}

async function join(hostId: string): Promise<void> {
  log(`joining host ${hostId} (protocol tested against pear-desktop ${TESTED_AGAINST})`);

  const guest = new MusicTogetherGuest({
    hostId,
    profile: GUEST_PROFILE,
    onOpen: (selfId) => log(`broker assigned us id ${selfId}`),
    onClose: (reason) => log(`connection closed: ${reason}`),
    onError: (err) => log(`ERROR ${err.message}`),
    onUnknown: (type, payload) =>
      log(`!! UNKNOWN EVENT ${type} — protocol may have drifted`, payload),
  });

  guest
    .on('SYNC_QUEUE', (p) => log(`SYNC_QUEUE ${p.videoList.length} tracks`, p.videoList.slice(0, 3)))
    .on('ADD_SONGS', (p) => log(`ADD_SONGS ${p.videoList.length} at ${p.index ?? 'end'}`, p.videoList))
    .on('REMOVE_SONG', (p) => log('REMOVE_SONG', p))
    .on('MOVE_SONG', (p) => log('MOVE_SONG', p))
    .on('SET_INDEX', (p) => log('SET_INDEX', p))
    .on('CLEAR_QUEUE', () => log('CLEAR_QUEUE'))
    .on('SYNC_PROGRESS', (p) => log('SYNC_PROGRESS', p))
    .on('SYNC_PROFILE', (p) => log(`SYNC_PROFILE ${Object.keys(p.profiles ?? {}).length} peers`))
    .on('IDENTIFY', (p) => log('IDENTIFY', p))
    .on('PERMISSION', (p) => {
      log(`PERMISSION granted: ${p ?? '(none)'}`);
      log(`  -> explicit write grant: ${guest.hasExplicitWriteGrant}`);
    })
    .on('CONNECTION_CLOSED', () => log('CONNECTION_CLOSED'));

  await guest.connect();
  log('connected — listening. Ctrl-C to stop.');

  const shutdown = async () => {
    log('shutting down…');
    guest.close();
    await cleanupWebRTC();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Write test: can a guest actually change the session's playback state?
 *
 * Joins, waits for the host's own SYNC_PROGRESS so we know the current index and
 * position, then echoes it back with `state` changed. Whether the host honours
 * that is exactly what we're measuring -- no PERMISSION event has been observed
 * arriving, so this may well be ignored.
 */
async function setState(hostId: string, target: number, label: string): Promise<void> {
  log(`joining host ${hostId} to attempt ${label}`);

  let latest: { progress?: number; state?: number; index?: number } | undefined;
  let sent = false;
  let observedAfterSend: number[] = [];

  const guest = new MusicTogetherGuest({
    hostId,
    profile: GUEST_PROFILE,
    onOpen: (selfId) => log(`broker assigned us id ${selfId}`),
    onError: (err) => log(`ERROR ${err.message}`),
    onUnknown: (type, payload) => log(`!! UNKNOWN EVENT ${type}`, payload),
  });

  guest
    .on('PERMISSION', (p) => log(`PERMISSION granted: ${p ?? '(none)'}`))
    .on('SYNC_PROGRESS', (p) => {
      latest = p;
      if (sent) {
        observedAfterSend.push(p.state ?? -99);
        log(`  host now reports state=${stateName(p.state)} progress=${p.progress?.toFixed(1)}`);
      }
    });

  await guest.connect();
  log('connected, waiting for host state…');

  // Wait for the host to tell us where it is before echoing anything back.
  await new Promise<void>((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (latest || Date.now() - started > 10_000) {
        clearInterval(tick);
        resolve();
      }
    }, 200);
  });

  if (!latest) {
    log('no SYNC_PROGRESS arrived within 10s — cannot attempt a write');
    guest.close();
    await cleanupWebRTC();
    process.exit(1);
  }

  log(`host is at index=${latest.index} progress=${latest.progress?.toFixed(1)} state=${stateName(latest.state)}`);
  log(`sending SYNC_PROGRESS with state=${target} (${label})…`);

  guest.send('SYNC_PROGRESS', {
    progress: latest.progress,
    state: target,
    index: latest.index,
  });
  sent = true;

  // Watch what the host does next.
  await new Promise((r) => setTimeout(r, 8000));

  const honoured = observedAfterSend.some((s) => s === target);
  log('');
  log(`RESULT: host ${honoured ? 'HONOURED' : 'IGNORED'} the guest ${label} request`);
  log(`  states seen after send: ${observedAfterSend.map(stateName).join(', ') || '(none)'}`);

  guest.close();
  await cleanupWebRTC();
  process.exit(honoured ? 0 : 2);
}

/**
 * Queue write test: add a track as a guest.
 *
 * Doubles as the read test -- if the host broadcasts SYNC_QUEUE or echoes
 * ADD_SONGS on change, this is what should trigger it, since nothing arrives
 * unsolicited on join.
 */
async function addSong(hostId: string, videoId: string, playNext = false): Promise<void> {
  log(`joining host ${hostId} to ${playNext ? 'play-next' : 'append'} videoId=${videoId}`);

  const received: string[] = [];
  let currentIndex: number | undefined;

  const guest = new MusicTogetherGuest({
    hostId,
    profile: GUEST_PROFILE,
    onOpen: (selfId) => log(`broker assigned us id ${selfId}`),
    onError: (err) => log(`ERROR ${err.message}`),
    onUnknown: (type, payload) => log(`!! UNKNOWN EVENT ${type}`, payload),
  });

  guest
    .on('PERMISSION', (p) => log(`PERMISSION granted: ${p ?? '(none)'}`))
    .on('SYNC_QUEUE', (p) => {
      received.push('SYNC_QUEUE');
      log(`SYNC_QUEUE — ${p.videoList?.length ?? 0} tracks`, p.videoList?.slice(0, 5));
    })
    .on('ADD_SONGS', (p) => {
      received.push('ADD_SONGS');
      log(`ADD_SONGS echoed back — ${p.videoList?.length ?? 0} at ${p.index ?? 'end'}`, p.videoList);
    })
    .on('SET_INDEX', (p) => { received.push('SET_INDEX'); log('SET_INDEX', p); })
    .on('SYNC_PROGRESS', (p) => { currentIndex = p.index; });

  await guest.connect();
  log('connected, settling for 3s…');
  await new Promise((r) => setTimeout(r, 3000));

  // Appending is useless when the host has infinite playback / autoplay on: the
  // queue has no reachable end, so an appended track is never played. Inserting
  // right after the current index is what "play next" means, and it is also the
  // right default for the bridge -- a track mirrored from Spotify should play
  // next, not vanish into an endless tail.
  const index = playNext && currentIndex !== undefined ? currentIndex + 1 : undefined;

  if (playNext && currentIndex === undefined) {
    log('WARNING: no SYNC_PROGRESS yet, cannot compute play-next index — appending');
  }

  log(`sending ADD_SONGS${index !== undefined ? ` at index ${index}` : ' (append)'}…`);
  guest.send('ADD_SONGS', {
    videoList: [{ videoId, ownerId: GUEST_PROFILE.id }],
    ...(index !== undefined ? { index } : {}),
  });

  await new Promise((r) => setTimeout(r, 8000));

  log('');
  log(`RESULT: queue events received after add: ${received.join(', ') || '(none)'}`);
  log('  Check pear-desktop: did the track appear in the queue?');

  guest.close();
  await cleanupWebRTC();
  process.exit(0);
}

/**
 * Distinguishes *why* queue writes don't reach the player.
 *
 * Inserts a track at currentIndex+1, waits for the session model to settle, then
 * sends SET_INDEX to that slot. Three outcomes, three different conclusions:
 *
 *   - track plays                  -> queue sync works (autoplay was the blocker)
 *   - SYNC_QUEUE grows, index
 *     moves, but audio unchanged   -> session queue is decorative; now-playing only
 *   - index snaps back             -> host rejects guest index control
 */
async function queueProbe(hostId: string, videoId: string): Promise<void> {
  log(`joining host ${hostId} for queue probe with videoId=${videoId}`);

  let currentIndex: number | undefined;
  let queueLen: number | undefined;
  const indexTrail: number[] = [];
  let targetIndex: number | undefined;

  const guest = new MusicTogetherGuest({
    hostId,
    profile: GUEST_PROFILE,
    onOpen: (id) => log(`broker assigned us id ${id}`),
    onError: (err) => log(`ERROR ${err.message}`),
    onUnknown: (t, p) => log(`!! UNKNOWN ${t}`, p),
  });

  guest
    .on('SYNC_PROGRESS', (p) => {
      currentIndex = p.index;
      if (targetIndex !== undefined && p.index !== undefined) indexTrail.push(p.index);
    })
    .on('SYNC_QUEUE', (p) => {
      queueLen = p.videoList?.length;
      log(`SYNC_QUEUE — ${queueLen} tracks`);
    })
    .on('ADD_SONGS', (p) => log(`ADD_SONGS echoed at ${p.index ?? 'end'}`));

  await guest.connect();
  log('connected, settling 4s…');
  await new Promise((r) => setTimeout(r, 4000));

  if (currentIndex === undefined) {
    log('no SYNC_PROGRESS — aborting');
    guest.close();
    await cleanupWebRTC();
    process.exit(1);
  }

  const before = queueLen;
  targetIndex = currentIndex + 1;

  log(`step 1: inserting at index ${targetIndex} (current=${currentIndex}, queue=${before ?? '?'})`);
  guest.send('ADD_SONGS', {
    videoList: [{ videoId, ownerId: GUEST_PROFILE.id }],
    index: targetIndex,
  });

  await new Promise((r) => setTimeout(r, 6000));
  log(`step 2: sending SET_INDEX ${targetIndex} to force the player onto it`);
  guest.send('SET_INDEX', { index: targetIndex });

  await new Promise((r) => setTimeout(r, 8000));

  const reached = indexTrail.includes(targetIndex);
  const settled = indexTrail.at(-1);

  log('');
  log('--- RESULT ---');
  log(`  queue length: ${before ?? '?'} -> ${queueLen ?? '?'}`);
  log(`  SET_INDEX target ${targetIndex}: ${reached ? 'REACHED' : 'never reached'}`);
  log(`  index settled at: ${settled ?? '?'}`);
  log(`  index trail: ${indexTrail.join(',') || '(none)'}`);
  log('');
  log('  Now check pear-desktop: is the inserted track PLAYING (not just listed)?');
  log('   - playing            -> queue sync works, autoplay was the blocker');
  log('   - listed but silent  -> session queue is decorative; now-playing only');
  log('   - index snapped back -> host rejects guest index control');

  guest.close();
  await cleanupWebRTC();
  process.exit(0);
}

/** Seek test: ask the host to jump to a position. */
async function seek(hostId: string, seconds: number): Promise<void> {
  log(`joining host ${hostId} to seek to ${seconds}s`);

  let latest: { progress?: number; state?: number; index?: number } | undefined;
  let sent = false;
  const after: number[] = [];

  const guest = new MusicTogetherGuest({
    hostId,
    profile: GUEST_PROFILE,
    onOpen: (selfId) => log(`broker assigned us id ${selfId}`),
    onError: (err) => log(`ERROR ${err.message}`),
  });

  guest.on('SYNC_PROGRESS', (p) => {
    latest = p;
    if (sent) after.push(p.progress ?? -1);
  });

  await guest.connect();
  await new Promise((r) => setTimeout(r, 2500));

  if (!latest) {
    log('no SYNC_PROGRESS arrived — aborting');
    guest.close();
    await cleanupWebRTC();
    process.exit(1);
  }

  log(`host at progress=${latest.progress?.toFixed(1)} index=${latest.index}`);
  log(`sending SYNC_PROGRESS progress=${seconds}…`);
  guest.send('SYNC_PROGRESS', {
    progress: seconds,
    state: latest.state,
    index: latest.index,
  });
  sent = true;

  await new Promise((r) => setTimeout(r, 6000));

  const jumped = after.some((p) => Math.abs(p - seconds) < 4);
  log('');
  log(`RESULT: host ${jumped ? 'HONOURED' : 'IGNORED'} the guest seek`);
  log(`  positions after send: ${after.map((p) => p.toFixed(1)).join(', ') || '(none)'}`);

  guest.close();
  await cleanupWebRTC();
  process.exit(jumped ? 0 : 2);
}

const arg = process.argv[2];
const mode = process.argv[3];

if (arg && mode === '--pause') {
  await setState(arg, PlayerState.PAUSED, 'pause');
} else if (arg && mode === '--play') {
  await setState(arg, PlayerState.PLAYING, 'play');
} else if (arg && (mode === '--add' || mode === '--next')) {
  const videoId = process.argv[4];
  if (!videoId) {
    console.error(`usage: bun run src/main.ts <host-id> ${mode} <videoId>`);
    process.exit(1);
  }
  await addSong(arg, videoId, mode === '--next');
} else if (arg && mode === '--queue-probe') {
  const videoId = process.argv[4];
  if (!videoId) {
    console.error('usage: bun run src/main.ts <host-id> --queue-probe <videoId>');
    process.exit(1);
  }
  await queueProbe(arg, videoId);
} else if (arg && mode === '--seek') {
  const seconds = Number(process.argv[4]);
  if (!Number.isFinite(seconds)) {
    console.error('usage: bun run src/main.ts <host-id> --seek <seconds>');
    process.exit(1);
  }
  await seek(arg, seconds);
} else if (arg === '--probe') {
  await probe();
} else if (!arg) {
  console.error(
    'usage:\n' +
      '  bun run src/main.ts --probe                        check the runtime\n' +
      '  bun run src/main.ts <host-id>                      join and log everything\n' +
      '  bun run src/main.ts <host-id> --pause              pause the session\n' +
      '  bun run src/main.ts <host-id> --play               resume the session\n' +
      '  bun run src/main.ts <host-id> --seek <seconds>     seek the session\n' +
      '  bun run src/main.ts <host-id> --next <videoId>     queue a track to play NEXT\n' +
      '  bun run src/main.ts <host-id> --add <videoId>      append (useless w/ autoplay on)\n\n' +
      'Get the host id from pear-desktop: Music Together -> host a session -> copy id.',
  );
  process.exit(1);
} else {
  try {
    await join(arg);
  } catch (err) {
    log(`FAILED: ${(err as Error).message}`);
    await cleanupWebRTC();
    process.exit(1);
  }
}
