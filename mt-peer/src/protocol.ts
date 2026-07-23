/**
 * Music Together wire protocol.
 *
 * Mirrored from pear-desktop `src/plugins/music-together/{types,connection}.ts`
 * at v3.12.0. This is a plugin-internal protocol with no compatibility promise,
 * so it is pinned to a tested version and unknown event types are surfaced
 * loudly rather than ignored -- see AGENTS.md constraint 7.
 */

/** pear-desktop version whose protocol this was written against. */
export const TESTED_AGAINST = '3.12.0';

export type Profile = {
  id: string;
  handleId: string;
  name: string;
  thumbnail: string;
};

/**
 * What the session actually exchanges for a track: an id, not metadata.
 * Resolving videoId -> title/artist/duration is our job (ytmusicapi).
 */
export type VideoData = {
  videoId: string;
  ownerId: string;
};

/**
 * Guest write access, controlled by the host.
 *  - `host-only` : guests are read-only. We can observe but not queue.
 *  - `playlist`  : guests may modify the queue.
 *  - `all`       : full control.
 */
export type Permission = 'host-only' | 'playlist' | 'all';

export type ConnectionEventMap = {
  ADD_SONGS: { videoList: VideoData[]; index?: number };
  REMOVE_SONG: { index: number };
  MOVE_SONG: { fromIndex: number; toIndex: number };
  SET_INDEX: { index: number };
  CLEAR_QUEUE: null;
  SYNC_QUEUE: { videoList: VideoData[] };
  SYNC_PROGRESS: { progress?: number; state?: number; index?: number };
  IDENTIFY: { profile: Profile };
  SYNC_PROFILE: { profiles: Record<string, Profile> };
  PERMISSION: Permission | undefined;
  CONNECTION_CLOSED: null;
};

export type ConnectionEvent = keyof ConnectionEventMap;

/** The envelope every message travels in. `after` chains follow-up events. */
export type ConnectionEventUnion = {
  [E in ConnectionEvent]: {
    type: E;
    payload: ConnectionEventMap[E];
    after?: ConnectionEventUnion[];
  };
}[ConnectionEvent];

/**
 * `SYNC_PROGRESS.state` values. These are YouTube IFrame player states, which is
 * what the plugin forwards -- confirmed live: a playing session reports 1.
 */
export const PlayerState = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

export function stateName(state: number | undefined): string {
  const found = Object.entries(PlayerState).find(([, v]) => v === state);
  return found ? found[0] : `UNKNOWN(${state})`;
}

export const KNOWN_EVENTS: readonly ConnectionEvent[] = [
  'ADD_SONGS',
  'REMOVE_SONG',
  'MOVE_SONG',
  'SET_INDEX',
  'CLEAR_QUEUE',
  'SYNC_QUEUE',
  'SYNC_PROGRESS',
  'IDENTIFY',
  'SYNC_PROFILE',
  'PERMISSION',
  'CONNECTION_CLOSED',
] as const;

export function isKnownEvent(type: unknown): type is ConnectionEvent {
  return typeof type === 'string' && (KNOWN_EVENTS as readonly string[]).includes(type);
}

/**
 * ICE configuration copied from the plugin so our guest negotiates the same way
 * the desktop client's guests do.
 */
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
    username: 'peerjs',
    credential: 'peerjsp',
  },
  {
    urls: 'turn:freestun.net:3478',
    username: 'free',
    credential: 'free',
  },
];
