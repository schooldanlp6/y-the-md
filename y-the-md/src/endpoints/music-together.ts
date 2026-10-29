/**
 * Music Together endpoint.
 *
 * The only hook that reaches *other* listeners — api-server and MPRIS control
 * this machine alone. That makes it a single point of failure for `reach`
 * (AGENTS.md constraint 9), so it is also the one whose absence must degrade
 * gracefully rather than break the client.
 *
 * It carries no track metadata: the session exchanges `{videoId, ownerId}` only,
 * which is why `metadata` is not among its capabilities.
 */
import { MusicTogetherGuest } from '../mt/connection.ts';
import { PlayerState, type Profile } from '../mt/protocol.ts';
import type { Endpoint, NowPlaying, QueueItem, QueueSnapshot } from './types.ts';

export class MusicTogetherEndpoint implements Endpoint {
  readonly name = 'music-together' as const;

  private guest?: MusicTogetherGuest;
  private connected = false;
  /** Reconnect backoff after a failed join -- see connect(). */
  private retryAt = 0;
  private retryDelayMs = 0;

  // Latest broadcast state. The host sends SYNC_PROGRESS at 1Hz.
  private progress?: { progress?: number; state?: number; index?: number };
  private queueItems: QueueItem[] = [];

  constructor(
    private readonly hostId: string | undefined,
    private readonly profile: Profile,
  ) {}

  async available(): Promise<boolean> {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (!this.hostId) {
      // No session to join is a normal state, not an error -- the other two
      // hooks still work.
      return;
    }
    if (this.connected) return;
    if (Date.now() < this.retryAt) {
      throw new Error(
        `not rejoining yet; next attempt in ${Math.ceil((this.retryAt - Date.now()) / 1000)}s`,
      );
    }
    // Reconnecting after a drop: release the dead peer before making another,
    // and forget the old session's state. SYNC_QUEUE is never sent on join, so
    // a stale copy would otherwise absorb the next edits and give wrong indexes;
    // empty, queue() reports "unknown" until a fresh snapshot arrives.
    this.guest?.close();
    this.guest = undefined;
    this.queueItems = [];
    this.progress = undefined;

    const guest = new MusicTogetherGuest({
      hostId: this.hostId,
      profile: this.profile,
      onClose: () => {
        this.connected = false;
      },
    });

    guest
      .on('SYNC_PROGRESS', (p) => {
        this.progress = p;
      })
      .on('SYNC_QUEUE', (p) => {
        // Only videoIds are carried; titles must come from another hook.
        this.queueItems = (p.videoList ?? []).map((v) => ({ videoId: v.videoId }));
      })
      .on('ADD_SONGS', (p) => {
        const incoming = (p.videoList ?? []).map((v) => ({ videoId: v.videoId }));
        const at = p.index ?? this.queueItems.length;
        this.queueItems.splice(at, 0, ...incoming);
      })
      // Edits by other participants. SYNC_QUEUE does eventually follow most of
      // them, but seconds later -- and until then every index we compute
      // (current track, insert position) would be off.
      .on('REMOVE_SONG', (p) => {
        this.queueItems.splice(p.index, 1);
      })
      .on('MOVE_SONG', (p) => {
        const [moved] = this.queueItems.splice(p.fromIndex, 1);
        if (moved) this.queueItems.splice(p.toIndex, 0, moved);
      })
      .on('CLEAR_QUEUE', () => {
        this.queueItems = [];
      })
      .on('SET_INDEX', (p) => {
        if (this.progress) this.progress = { ...this.progress, index: p.index };
      });

    try {
      await guest.connect();
    } catch (err) {
      guest.close();
      // Every attempt goes through the public PeerJS broker, which we don't
      // run; an expired host id must not turn into a retry storm against it.
      this.retryDelayMs = Math.min(Math.max(this.retryDelayMs * 2, 15_000), 300_000);
      this.retryAt = Date.now() + this.retryDelayMs;
      throw err;
    }
    this.guest = guest;
    this.connected = true;
    this.retryDelayMs = 0;
  }

  async close(): Promise<void> {
    this.guest?.close();
    this.connected = false;
  }

  private send(state?: number, progressSeconds?: number): void {
    if (!this.guest) throw new Error('not connected to a Music Together session');
    this.guest.send('SYNC_PROGRESS', {
      progress: progressSeconds ?? this.progress?.progress,
      state: state ?? this.progress?.state,
      index: this.progress?.index,
    });
  }

  // --- transport ---
  async play(): Promise<void> {
    this.send(PlayerState.PLAYING);
  }
  async pause(): Promise<void> {
    this.send(PlayerState.PAUSED);
  }
  async next(): Promise<void> {
    if (this.progress?.index === undefined) throw new Error('no current index yet');
    this.guest!.send('SET_INDEX', { index: this.progress.index + 1 });
  }
  async previous(): Promise<void> {
    if (this.progress?.index === undefined) throw new Error('no current index yet');
    this.guest!.send('SET_INDEX', { index: Math.max(0, this.progress.index - 1) });
  }

  // --- seek ---
  async seekTo(seconds: number): Promise<void> {
    this.send(undefined, seconds);
  }

  // --- position (no metadata: the protocol carries none) ---
  async nowPlaying(): Promise<NowPlaying | undefined> {
    if (!this.progress) return undefined;
    const index = this.progress.index;
    return {
      videoId: index !== undefined ? this.queueItems[index]?.videoId : undefined,
      positionMs:
        this.progress.progress !== undefined
          ? Math.round(this.progress.progress * 1000)
          : undefined,
      paused: this.progress.state !== PlayerState.PLAYING,
    };
  }

  // --- queue ---
  async queue(): Promise<QueueSnapshot | undefined> {
    if (!this.queueItems.length) return undefined;
    return {
      items: this.queueItems.map((it, i) => ({
        ...it,
        current: i === this.progress?.index,
      })),
      currentIndex: this.progress?.index,
    };
  }

  async enqueue(videoId: string, position: 'next' | 'end'): Promise<void> {
    if (!this.guest) throw new Error('not connected to a Music Together session');
    // Appending is unreachable under autoplay, so 'next' inserts after current.
    const index =
      position === 'next' && this.progress?.index !== undefined
        ? this.progress.index + 1
        : undefined;
    this.guest.send('ADD_SONGS', {
      videoList: [{ videoId, ownerId: this.profile.id }],
      ...(index !== undefined ? { index } : {}),
    });
  }

  /**
   * Insert at an exact index. Music Together takes one natively, so unlike
   * the api-server this needs no insert-then-move.
   *
   * True once the host has echoed the add back, which is when it entered the
   * session queue; false if it was sent but not echoed (it may still land).
   * Throws only if nothing was sent.
   */
  async insertAt(videoId: string, index: number): Promise<boolean> {
    if (!this.guest) throw new Error('not connected to a Music Together session');
    const before = this.queueItems.length;
    this.guest.send('ADD_SONGS', {
      videoList: [{ videoId, ownerId: this.profile.id }],
      index,
    });
    // Checked by presence, not position: until the first SYNC_QUEUE our local
    // copy is empty, and an echo spliced at `index` lands at its end instead.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (
        this.queueItems.length > before &&
        this.queueItems.some((item) => item.videoId === videoId)
      ) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  async setIndex(index: number): Promise<void> {
    if (!this.guest) throw new Error('not connected to a Music Together session');
    this.guest.send('SET_INDEX', { index });
  }

  async playTrack(videoId: string): Promise<void> {
    if (this.progress?.index === undefined) throw new Error('no current index yet');
    const at = this.progress.index + 1;
    // Jumping before the host has the track would play whatever was next.
    if (!(await this.insertAt(videoId, at))) {
      throw new Error(`host did not confirm ${videoId}; not jumping to an unknown track`);
    }
    await this.setIndex(at);
  }
}
