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
  private authRetryAt = 0;
  private authRetryDelayMs = 0;

  constructor(private readonly config: Config['apiServer']) {
    this.token = config.token;
  }

  private backOffAuth(): void {
    this.authRetryDelayMs = Math.min(Math.max(this.authRetryDelayMs * 2, 30_000), 600_000);
    this.authRetryAt = Date.now() + this.authRetryDelayMs;
  }

  private get base(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  async connect(): Promise<void> {
    if (this.token) return;
    // connect() is retried periodically (Router.refresh). For an approved
    // client id re-auth is silent, but a refused one shows pear-desktop's
    // approval dialog on every attempt -- so back off after a failure.
    if (Date.now() < this.authRetryAt) {
      throw new Error('api-server auth failed recently; not retrying yet');
    }

    // The auth route lives at the root, NOT under /api/v1 -- easy to get wrong,
    // and the wrong path returns 401 rather than 404, which looks like a bad
    // token instead of a bad URL.
    // Bounded: with AUTH_AT_FIRST an unapproved id holds this request open
    // until someone answers the dialog, which would stall every other hook's
    // reconnect behind it. Approving later still works -- pear-desktop records
    // the approval, and the next attempt is then silent.
    const res = await fetch(`${this.base}/auth/${this.config.clientId}`, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
    }).catch((err) => {
      this.backOffAuth();
      throw err;
    });
    if (!res.ok) {
      this.backOffAuth();
      throw new Error(
        `api-server auth failed (${res.status}). With AUTH_AT_FIRST an approval ` +
          'dialog appears in pear-desktop — accept it and retry.',
      );
    }
    this.authRetryDelayMs = 0;
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

    const res = await fetch(`${this.base}/api/v1${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401) {
      // A token we fetched ourselves (e.g. before pear-desktop restarted) is
      // dropped so the next connect() re-authenticates. One from the env is
      // kept: re-auth cannot fix it, and failing loudly is the useful answer.
      if (this.token !== this.config.token) this.token = undefined;
      throw new WriteRejected(`api-server rejected the token for ${path}`);
    }
    return res;
  }

  /** A write: anything but 2xx is an error, not a silent no-op. */
  private async write(path: string, init: RequestInit): Promise<void> {
    const res = await this.call(path, init);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new WriteRejected(`api-server ${init.method ?? 'GET'} ${path} -> ${res.status} ${detail}`.trim());
    }
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
    await this.write('/play', { method: 'POST' });
  }
  async pause(): Promise<void> {
    await this.write('/pause', { method: 'POST' });
  }
  async next(): Promise<void> {
    await this.write('/next', { method: 'POST' });
  }
  async previous(): Promise<void> {
    await this.write('/previous', { method: 'POST' });
  }

  // --- seek ---
  async seekTo(seconds: number): Promise<void> {
    await this.write('/seek-to', {
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
      // Entries with a video counterpart come wrapped. pear-desktop unwraps
      // them the same way when it computes insert positions, and an entry we
      // cannot read still gets a slot: every index here must equal the
      // player's own, or inserts and moves land in the wrong place.
      const entry = raw as Record<string, any>;
      const r =
        entry?.playlistPanelVideoRenderer ??
        entry?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
      if (!r?.videoId) {
        items.push({ videoId: '' });
        return;
      }
      if (r.selected) currentIndex = i;
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
    await this.write('/queue', {
      method: 'POST',
      body: JSON.stringify({
        videoId,
        insertPosition:
          position === 'next' ? 'INSERT_AFTER_CURRENT_VIDEO' : 'INSERT_AT_END',
      }),
    });
  }

  async dequeue(index: number): Promise<void> {
    await this.write(`/queue/${index}`, { method: 'DELETE' });
  }

  async moveInQueue(fromIndex: number, toIndex: number): Promise<void> {
    await this.write(`/queue/${fromIndex}`, {
      method: 'PATCH',
      body: JSON.stringify({ toIndex }),
    });
  }

  async setIndex(index: number): Promise<void> {
    await this.write('/queue', {
      method: 'PATCH',
      body: JSON.stringify({ index }),
    });
  }

  /**
   * Insert at `index`.
   *
   * The api-server has no insert-at-index, and its insert is fire-and-forget:
   * `POST /queue` answers 204 at once, while pear-desktop fetches the track's
   * data and only then splices it in after the current track. So: insert
   * after current, wait until it has *landed*, then move it. Moving any
   * earlier would move whatever was previously next.
   *
   * True once the track is in the queue; false if the insert was sent but not
   * seen to land (it may still). Throws only if nothing can have been written,
   * which is the one case where simply retrying is safe.
   */
  async insertAt(videoId: string, index: number): Promise<boolean> {
    const before = await this.queue();
    if (before?.currentIndex === undefined) {
      throw new Error('cannot insert: the queue has no current track');
    }
    const landed = before.currentIndex + 1;

    try {
      await this.enqueue(videoId, 'next');
    } catch (err) {
      // Refused outright: nothing was written. Anything else (a timeout, a
      // dropped connection) may have reached pear-desktop regardless.
      if (err instanceof WriteRejected) throw err;
      return (await this.positionAhead(videoId)) !== undefined;
    }

    const after = await this.waitForQueue(
      (q) => q.items.length > before.items.length && q.items[landed]?.videoId === videoId,
      INSERT_TIMEOUT_MS,
    );
    if (!after) {
      // Not where expected -- e.g. the track changed while we waited. Ahead of
      // current anywhere still counts; it is just not ordered.
      return (await this.positionAhead(videoId)) !== undefined;
    }

    if (index !== landed) {
      // A failed move leaves the track in the queue, merely out of order, so
      // it is reported rather than turned into a failed insert.
      try {
        await this.moveInQueue(landed, index);
        const moved = await this.waitForQueue(
          (q) => q.items[index]?.videoId === videoId,
          INSERT_TIMEOUT_MS,
        );
        if (!moved) {
          console.warn(`api-server: moved ${videoId} ${landed} -> ${index} but it is not at ${index}`);
        }
      } catch (err) {
        console.warn(`api-server: could not move ${videoId} to ${index}: ${(err as Error).message}`);
      }
    }
    return true;
  }

  /** Index of `videoId` ahead of the current track, if it is there. */
  private async positionAhead(videoId: string): Promise<number | undefined> {
    const q = await this.queue().catch(() => undefined);
    const current = q?.currentIndex;
    if (!q || current === undefined) return undefined;
    const i = q.items.findIndex((item, at) => at > current && item.videoId === videoId);
    return i < 0 ? undefined : i;
  }

  /**
   * Play a specific track now.
   *
   * YouTube Music has no "play this id" verb, so this is insert-next followed by
   * skip. Inserting at the end would be unreachable under autoplay, which is why
   * INSERT_AFTER_CURRENT_VIDEO is not optional here (AGENTS.md constraint 7).
   */
  async playTrack(videoId: string): Promise<void> {
    const before = await this.queue();
    await this.enqueue(videoId, 'next');
    // Skipping before the insert has landed plays whatever was previously next.
    if (before?.currentIndex !== undefined) {
      const landed = before.currentIndex + 1;
      await this.waitForQueue((q) => q.items[landed]?.videoId === videoId, INSERT_TIMEOUT_MS);
    } else {
      await new Promise((r) => setTimeout(r, 400));
    }
    await this.next();
  }

  /** Poll the queue until `done` holds; the last snapshot, or undefined on timeout. */
  private async waitForQueue(
    done: (q: QueueSnapshot) => boolean,
    timeoutMs: number,
  ): Promise<QueueSnapshot | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // One failed read is not an answer; keep polling until the deadline.
      const q = await this.queue().catch(() => undefined);
      if (q && done(q)) return q;
      await new Promise((r) => setTimeout(r, 150));
    }
    return undefined;
  }
}

/** pear-desktop fetches track data before inserting; a few seconds is plenty. */
const INSERT_TIMEOUT_MS = 5000;

/** pear-desktop answered and refused (4xx/5xx, bad token): unlike a lost response, nothing was written. */
class WriteRejected extends Error {}

/** "3:45" or "1:02:03" -> ms */
function parseLength(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const parts = text.split(':').map(Number);
  if (parts.some(Number.isNaN)) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0) * 1000;
}
