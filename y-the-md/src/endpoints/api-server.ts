/**
 * pear-desktop api-server endpoint.
 *
 * Local only -- controls the pear-desktop on this machine, not the shared
 * session. But it is the richest source of *data*: full track metadata and the
 * real player queue, neither of which Music Together provides.
 *
 * Auth: POST /auth/{clientId} (note: at the ROOT, not under /api/v1) returns a
 * JWT. With AUTH_AT_FIRST the first caller is approved via an in-app dialog.
 */
import type { Config } from '../config.ts';
import type { Endpoint, NowPlaying, QueueItem, QueueSnapshot } from './types.ts';

export class ApiServerEndpoint implements Endpoint {
  readonly name = 'api-server' as const;
  private token?: string;

  constructor(private readonly config: Config['apiServer']) {
    this.token = config.token;
  }

  private get base(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  async connect(): Promise<void> {
    if (this.token) return;

    // The auth route lives at the root, NOT under /api/v1 -- easy to get wrong,
    // and the wrong path returns 401 rather than 404, which looks like a bad
    // token instead of a bad URL.
    const res = await fetch(`${this.base}/auth/${this.config.clientId}`, {
      method: 'POST',
    });
    if (!res.ok) {
      throw new Error(
        `api-server auth failed (${res.status}). With AUTH_AT_FIRST an approval ` +
          'dialog appears in pear-desktop — accept it and retry.',
      );
    }
    const body = (await res.json()) as { accessToken?: string };
    if (!body.accessToken) throw new Error('api-server auth returned no accessToken');
    this.token = body.accessToken;
  }

  private async call(path: string, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string>),
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (init?.body) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${this.base}/api/v1${path}`, { ...init, headers });
    if (res.status === 401) {
      throw new Error(`api-server rejected the token for ${path}`);
    }
    return res;
  }

  async available(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/api/v1/song`, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        signal: AbortSignal.timeout(2000),
      });
      // 401 still means the server is up -- connect() can fix the token.
      return res.ok || res.status === 401 || res.status === 204;
    } catch {
      return false;
    }
  }

  // --- transport ---
  async play(): Promise<void> {
    await this.call('/play', { method: 'POST' });
  }
  async pause(): Promise<void> {
    await this.call('/pause', { method: 'POST' });
  }
  async next(): Promise<void> {
    await this.call('/next', { method: 'POST' });
  }
  async previous(): Promise<void> {
    await this.call('/previous', { method: 'POST' });
  }

  // --- seek ---
  async seekTo(seconds: number): Promise<void> {
    await this.call('/seek-to', {
      method: 'POST',
      body: JSON.stringify({ seconds }),
    });
  }

  // --- position + metadata (one call serves both) ---
  async nowPlaying(): Promise<NowPlaying | undefined> {
    const res = await this.call('/song');
    if (res.status === 204) return undefined;

    const s = (await res.json()) as Record<string, unknown>;
    return {
      videoId: s.videoId as string | undefined,
      title: s.title as string | undefined,
      artist: s.artist as string | undefined,
      album: s.album as string | undefined,
      // api-server reports whole seconds; callers should expect ~1s granularity.
      durationMs: typeof s.songDuration === 'number' ? s.songDuration * 1000 : undefined,
      positionMs:
        typeof s.elapsedSeconds === 'number' ? s.elapsedSeconds * 1000 : undefined,
      paused: s.isPaused as boolean | undefined,
    };
  }

  // --- queue ---
  async queue(): Promise<QueueSnapshot | undefined> {
    const res = await this.call('/queue');
    if (res.status === 204) return undefined;

    const d = (await res.json()) as {
      items?: unknown[];
      autoPlaying?: boolean;
    };

    const items: QueueItem[] = [];
    let currentIndex: number | undefined;

    (d.items ?? []).forEach((raw, i) => {
      const r = (raw as Record<string, any>)?.playlistPanelVideoRenderer;
      if (!r?.videoId) return;
      if (r.selected) currentIndex = items.length;
      items.push({
        videoId: r.videoId,
        title: r.title?.runs?.[0]?.text,
        artist: r.shortBylineText?.runs?.[0]?.text,
        durationMs: parseLength(r.lengthText?.runs?.[0]?.text),
        current: Boolean(r.selected),
      });
    });

    return { items, currentIndex, autoPlaying: d.autoPlaying };
  }

  async enqueue(videoId: string, position: 'next' | 'end'): Promise<void> {
    // INSERT_AT_END is the API default, and with an autoplay-extended queue the
    // end is unreachable -- a track added there never plays. 'next' is what the
    // bridge almost always wants. See AGENTS.md constraint 7.
    await this.call('/queue', {
      method: 'POST',
      body: JSON.stringify({
        videoId,
        insertPosition:
          position === 'next' ? 'INSERT_AFTER_CURRENT_VIDEO' : 'INSERT_AT_END',
      }),
    });
  }

  async dequeue(index: number): Promise<void> {
    await this.call(`/queue/${index}`, { method: 'DELETE' });
  }

  async moveInQueue(fromIndex: number, toIndex: number): Promise<void> {
    await this.call(`/queue/${fromIndex}`, {
      method: 'PATCH',
      body: JSON.stringify({ toIndex }),
    });
  }

  async setIndex(index: number): Promise<void> {
    await this.call('/queue', {
      method: 'PATCH',
      body: JSON.stringify({ index }),
    });
  }

  /**
   * Play a specific track now.
   *
   * YouTube Music has no "play this id" verb, so this is insert-next followed by
   * skip. Inserting at the end would be unreachable under autoplay, which is why
   * INSERT_AFTER_CURRENT_VIDEO is not optional here (AGENTS.md constraint 7).
   */
  async playTrack(videoId: string): Promise<void> {
    await this.enqueue(videoId, 'next');
    // Give the client a moment to register the insert before skipping onto it;
    // skipping too early lands on whatever was previously next.
    await new Promise((r) => setTimeout(r, 400));
    await this.next();
  }
}

/** "3:45" or "1:02:03" -> ms */
function parseLength(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const parts = text.split(':').map(Number);
  if (parts.some(Number.isNaN)) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0) * 1000;
}
