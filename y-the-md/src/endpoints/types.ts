/**
 * What every endpoint implements.
 *
 * An endpoint offers a *subset* of the interface — whatever its capabilities in
 * `SUPPORT` say. Unsupported methods are simply absent, and the router never
 * calls them, so there are no "not implemented" stubs to trip over.
 */
import type { Capability, EndpointName } from '../capabilities.ts';

export type NowPlaying = {
  videoId?: string;
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  positionMs?: number;
  paused?: boolean;
};

export type QueueItem = {
  /** Empty for an entry the endpoint could not parse; kept so indexes stay aligned. */
  videoId: string;
  title?: string;
  artist?: string;
  durationMs?: number;
  /** True for the track currently playing. */
  current?: boolean;
};

export type QueueSnapshot = {
  items: QueueItem[];
  currentIndex?: number;
  autoPlaying?: boolean;
};

export type Endpoint = {
  readonly name: EndpointName;

  /** Cheap liveness check. Router calls this before routing to it. */
  available(): Promise<boolean>;
  /** Called once before first use. */
  connect?(): Promise<void>;
  close?(): Promise<void>;

  // --- capability methods, present only if declared in SUPPORT ---
  play?(): Promise<void>;
  pause?(): Promise<void>;
  next?(): Promise<void>;
  previous?(): Promise<void>;
  seekTo?(seconds: number): Promise<void>;
  nowPlaying?(): Promise<NowPlaying | undefined>;
  queue?(): Promise<QueueSnapshot | undefined>;
  /** `position` is where the track goes; 'next' means straight after current. */
  enqueue?(videoId: string, position: 'next' | 'end'): Promise<void>;
  /**
   * Insert at an exact queue index (as numbered by this endpoint's `queue()`).
   * True once the track is confirmed in the queue; false if the write was sent
   * but not seen to land -- it may still, so check before writing it again.
   * Throws only when nothing can have been written.
   */
  insertAt?(videoId: string, index: number): Promise<boolean>;
  dequeue?(index: number): Promise<void>;
  moveInQueue?(fromIndex: number, toIndex: number): Promise<void>;
  setIndex?(index: number): Promise<void>;
  /** Play a specific track immediately. */
  playTrack?(id: string): Promise<void>;
};

/** Maps a capability to the endpoint methods that implement it. */
export const CAPABILITY_METHODS: Record<Capability, readonly (keyof Endpoint)[]> = {
  transport: ['play', 'pause', 'next', 'previous'],
  seek: ['seekTo'],
  position: ['nowPlaying'],
  metadata: ['nowPlaying'],
  queueRead: ['queue'],
  queueWrite: ['enqueue', 'insertAt', 'dequeue', 'moveInQueue', 'setIndex', 'playTrack'],
  reach: [],
};
