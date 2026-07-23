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
      });

    await guest.connect();
    this.guest = guest;
    this.connected = true;
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

  async setIndex(index: number): Promise<void> {
    if (!this.guest) throw new Error('not connected to a Music Together session');
    this.guest.send('SET_INDEX', { index });
  }

  async playTrack(videoId: string): Promise<void> {
    await this.enqueue(videoId, 'next');
    await new Promise((r) => setTimeout(r, 400));
    if (this.progress?.index !== undefined) {
      await this.setIndex(this.progress.index + 1);
    }
  }
}
