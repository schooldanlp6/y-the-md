/**
 * Client for the matcha song-matching service.
 *
 * matcha is stateless and cached, so calling it per track change is cheap --
 * a repeat is a SQLite hit, not a network round trip to a music platform.
 *
 * Auth is a single optional bearer token (matcha has exactly one caller class
 * and stores no user data; see AGENTS.md -> Authorization).
 */

export type MatchaTrack = {
  id?: string;
  title: string;
  artists: string[];
  album?: string;
  duration_ms?: number;
  isrc?: string;
};

export type MatchResult = {
  matched: boolean;
  source: string;
  target: string;
  target_id: string | null;
  track: MatchaTrack | null;
  confidence: number | null;
  method: string;
  cached: boolean;
  breakdown?: {
    title: number;
    artist: number;
    duration: number;
    vetoes: string[];
  };
  /** Present when a candidate was found but scored below the accept threshold. */
  rejected?: MatchaTrack;
};

export class MatchaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** True when matcha is reachable but a provider is not (e.g. Spotify 403). */
    readonly providerUnavailable = false,
  ) {
    super(message);
    this.name = 'MatchaError';
  }
}

export class MatchaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  private get base(): string {
    return this.baseUrl.replace(/\/$/, '');
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async health(): Promise<{
    status: string;
    providers: Record<string, boolean>;
    auth: string;
  }> {
    const res = await fetch(`${this.base}/api/v1/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new MatchaError(`matcha health ${res.status}`, res.status);
    return res.json() as Promise<{
      status: string;
      providers: Record<string, boolean>;
      auth: string;
    }>;
  }

  async available(): Promise<boolean> {
    try {
      await this.health();
      return true;
    } catch {
      return false;
    }
  }

  /** Resolve one track onto the other platform. */
  async match(
    track: MatchaTrack,
    source: 'ytm' | 'spotify',
    target?: 'ytm' | 'spotify',
  ): Promise<MatchResult> {
    const res = await fetch(`${this.base}/api/v1/match`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ source, ...(target ? { target } : {}), track }),
      signal: AbortSignal.timeout(20_000),
    });

    if (res.status === 503) {
      // matcha is up, the upstream platform is not -- worth distinguishing,
      // because the caller should degrade rather than treat it as a hard fault.
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new MatchaError(body.error ?? 'provider unavailable', 503, true);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new MatchaError(body.error ?? `matcha ${res.status}`, res.status);
    }

    return res.json() as Promise<MatchResult>;
  }

  /** Resolve many at once, for pre-matching the upcoming queue. */
  async matchBatch(
    tracks: MatchaTrack[],
    source: 'ytm' | 'spotify',
    target?: 'ytm' | 'spotify',
  ): Promise<{ count: number; matched: number; results: MatchResult[] }> {
    const res = await fetch(`${this.base}/api/v1/match/batch`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ source, ...(target ? { target } : {}), tracks }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new MatchaError(body.error ?? `matcha batch ${res.status}`, res.status);
    }
    return res.json() as Promise<{
      count: number;
      matched: number;
      results: MatchResult[];
    }>;
  }
}
