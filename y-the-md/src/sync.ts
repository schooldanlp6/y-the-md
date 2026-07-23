/**
 * Sync client: report state to matcha, execute the commands it sends back.
 *
 * Mirrors what spice-ify does on the Spotify side, so the server sees one
 * uniform client protocol regardless of platform:
 *
 *   POST /api/v1/ytm/state    what this player is doing  (~1 Hz)
 *   POST /api/v1/ytm/pending  claim commands addressed to us
 *   POST /api/v1/ytm/result   report what happened
 *
 * The engine decides; this only reports and obeys. Keeping the decision logic
 * server-side means one place to reason about drift and echo rather than one
 * per client.
 */
import type { Capability } from './capabilities.ts';
import type { Router } from './router.ts';

export type SyncOptions = {
  matchaUrl: string;
  clientId: string;
  token?: string;
  stateIntervalMs?: number;
  pollIntervalMs?: number;
  onLog?: (message: string) => void;
};

type PendingRequest = { id: string; kind: string; payload: any };

export class SyncClient {
  private stateTimer?: ReturnType<typeof setInterval>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private reachable = false;
  /** Guards against overlapping ticks when a command outlives its interval. */
  private busy = false;

  constructor(
    private readonly router: Router,
    private readonly options: SyncOptions,
  ) {}

  private log(message: string): void {
    this.options.onLog?.(message);
  }

  private async post(path: string, body: unknown): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;

    const res = await fetch(`${this.options.matchaUrl.replace(/\/$/, '')}/api/v1${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json();
  }

  /**
   * What this client can actually do right now.
   *
   * Derived from live routing, not hardcoded: if the only reachable endpoint is
   * MPRIS, we report no queue capability and the engine degrades us instead of
   * issuing writes that would fail.
   */
  private capabilities(): string[] {
    const caps: string[] = [];
    const map: Record<string, Capability> = {
      seek: 'seek',
      transport: 'transport',
      queue: 'queueWrite',
    };
    for (const [name, capability] of Object.entries(map)) {
      if (this.router.resolve(capability)) caps.push(name);
    }
    return caps;
  }

  private async reportState(): Promise<void> {
    try {
      const song = await this.router.invoke('metadata', (e) => e.nowPlaying!());
      await this.post('/ytm/state', {
        client_id: this.options.clientId,
        platform: 'ytm',
        state: {
          platform: 'ytm',
          capabilities: this.capabilities(),
          track_id: song?.videoId ?? null,
          title: song?.title ?? null,
          artists: song?.artist ? [song.artist] : [],
          album: song?.album ?? null,
          duration_ms: song?.durationMs ?? null,
          position_ms: song?.positionMs ?? null,
          paused: song?.paused ?? true,
        },
      });

      if (!this.reachable) {
        this.reachable = true;
        this.log('connected to matcha');
      }
    } catch (err) {
      if (this.reachable) {
        this.reachable = false;
        this.log(`matcha unreachable (${(err as Error).message}) — retrying`);
      }
    }
  }

  private async execute(request: PendingRequest): Promise<any> {
    const { action, value } = request.payload ?? {};

    switch (action) {
      case 'play':
        await this.router.invoke('transport', (e) => e.play!());
        return { ok: true };
      case 'pause':
        await this.router.invoke('transport', (e) => e.pause!());
        return { ok: true };
      case 'next':
        await this.router.invoke('transport', (e) => e.next!());
        return { ok: true };
      case 'previous':
        await this.router.invoke('transport', (e) => e.previous!());
        return { ok: true };
      case 'seek':
        // The engine speaks milliseconds; pear api-server wants seconds.
        await this.router.invoke('seek', (e) => e.seekTo!(Number(value) / 1000));
        return { ok: true };
      case 'playTrack':
        await this.router.invoke('queueWrite', (e) => e.playTrack!(String(value)));
        return { ok: true };
      case 'queue':
        await this.router.invoke('queueWrite', (e) => e.enqueue!(String(value), 'next'));
        return { ok: true };
      default:
        return { ok: false, error: `unknown action '${action}'` };
    }
  }

  private async pollCommands(): Promise<void> {
    if (!this.reachable || this.busy) return;
    this.busy = true;

    try {
      const { requests } = await this.post('/ytm/pending', {
        limit: 5,
        client_id: this.options.clientId,
      });

      for (const request of requests ?? []) {
        let result: any;
        try {
          result = await this.execute(request);
          this.log(
            `${request.payload?.action} ${request.payload?.value ?? ''} -> ${
              result.ok ? 'ok' : result.error
            }`,
          );
        } catch (err) {
          result = { ok: false, error: (err as Error).message };
          this.log(`${request.payload?.action} FAILED: ${(err as Error).message}`);
        }
        await this.post('/ytm/result', { id: request.id, result }).catch(() => {});
      }
    } catch {
      /* next tick retries */
    } finally {
      this.busy = false;
    }
  }

  async start(): Promise<void> {
    const stateMs = this.options.stateIntervalMs ?? 1000;
    const pollMs = this.options.pollIntervalMs ?? 500;

    await this.reportState();
    this.stateTimer = setInterval(() => void this.reportState(), stateMs);
    this.pollTimer = setInterval(() => void this.pollCommands(), pollMs);
  }

  stop(): void {
    if (this.stateTimer) clearInterval(this.stateTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
}
