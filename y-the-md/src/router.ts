/**
 * Capability router.
 *
 * Callers ask for a capability, not an endpoint. The router consults the
 * configured preference order, skips endpoints that are disabled or currently
 * unavailable, and dispatches to the first that can serve it.
 *
 * Two properties this is designed to preserve:
 *  - **Overrides are honoured exactly.** If the operator pins a capability to
 *    one endpoint, the router does not silently fall back to another; it fails,
 *    because a silent fallback makes the override look broken.
 *  - **Defaults do fall back.** Where the preference is the built-in default,
 *    trying the next endpoint is the whole point of having three hooks.
 */
import {
  isRedundant,
  providersFor,
  SUPPORT,
  type Capability,
  type EndpointName,
} from './capabilities.ts';
import { DEFAULT_PREFERENCE } from './capabilities.ts';
import type { Config } from './config.ts';
import type { Endpoint } from './endpoints/types.ts';

export class NoEndpointError extends Error {
  constructor(
    readonly capability: Capability,
    readonly tried: EndpointName[],
    detail: string,
  ) {
    super(`no endpoint available for '${capability}' (tried: ${tried.join(', ') || 'none'})${detail}`);
    this.name = 'NoEndpointError';
  }
}

export class Router {
  private availability = new Map<EndpointName, boolean>();

  constructor(
    private readonly config: Config,
    private readonly endpoints: Map<EndpointName, Endpoint>,
  ) {}

  /** Probe every endpoint once. Safe to re-run to refresh. */
  async probe(): Promise<Map<EndpointName, boolean>> {
    for (const [name, endpoint] of this.endpoints) {
      if (this.config.disabled.has(name)) {
        this.availability.set(name, false);
        continue;
      }
      try {
        this.availability.set(name, await endpoint.available());
      } catch {
        this.availability.set(name, false);
      }
    }
    return new Map(this.availability);
  }

  /**
   * Reconnect what dropped, then re-probe.
   *
   * `invoke` marks an endpoint down on its first failure, and nothing else
   * ever marks it up again -- so in a long-running client one transient error
   * (pear-desktop restarting, an expired token) would disable that hook for
   * good. Long-running callers call this periodically to recover.
   * `connect()` is a no-op on an endpoint that is already connected.
   */
  async refresh(): Promise<void> {
    for (const [name, endpoint] of this.endpoints) {
      if (this.config.disabled.has(name)) {
        this.availability.set(name, false);
        continue;
      }
      let up = false;
      try {
        await endpoint.connect?.();
        up = await endpoint.available();
      } catch {
        up = false;
      }
      this.availability.set(name, up);
    }
  }

  /** True if the operator pinned this capability rather than taking the default. */
  private isOverridden(capability: Capability): boolean {
    const configured = this.config.preference[capability];
    const dflt = DEFAULT_PREFERENCE[capability];
    return (
      configured.length !== dflt.length ||
      configured.some((e, i) => e !== dflt[i])
    );
  }

  /** The endpoint that would serve this capability right now, if any. */
  resolve(capability: Capability): Endpoint | undefined {
    for (const name of this.config.preference[capability]) {
      if (this.availability.get(name) === false) continue;
      const endpoint = this.endpoints.get(name);
      if (endpoint && SUPPORT[name].includes(capability)) return endpoint;
    }
    return undefined;
  }

  /**
   * Dispatch a capability call.
   *
   * `use` receives an endpoint already known to declare the capability; it is
   * still responsible for checking that the specific method exists, since a
   * capability can map to several methods.
   */
  async invoke<T>(
    capability: Capability,
    use: (endpoint: Endpoint) => Promise<T>,
  ): Promise<T> {
    const order = this.config.preference[capability];
    const tried: EndpointName[] = [];
    let lastError: unknown;

    for (const name of order) {
      if (this.config.disabled.has(name)) continue;
      if (this.availability.get(name) === false) continue;

      const endpoint = this.endpoints.get(name);
      if (!endpoint || !SUPPORT[name].includes(capability)) continue;

      tried.push(name);
      try {
        return await use(endpoint);
      } catch (err) {
        lastError = err;
        // A pinned capability must not quietly slide to another endpoint.
        if (this.isOverridden(capability)) throw err;
        this.availability.set(name, false);
      }
    }

    const detail = lastError ? `; last error: ${(lastError as Error).message}` : '';
    throw new NoEndpointError(capability, tried, detail);
  }

  /** Human-readable routing table, for `--status`. */
  describe(): string[] {
    const lines: string[] = [];
    for (const cap of Object.keys(this.config.preference) as Capability[]) {
      const chosen = this.resolve(cap);
      const order = this.config.preference[cap];
      const pinned = this.isOverridden(cap) ? ' (overridden)' : '';
      const redundancy = isRedundant(cap)
        ? `${providersFor(cap).length}-way`
        : 'SINGLE POINT OF FAILURE';
      lines.push(
        `  ${cap.padEnd(11)} -> ${(chosen?.name ?? 'NONE').padEnd(15)} ` +
          `[${order.join(' > ')}]${pinned}  ${redundancy}`,
      );
    }
    return lines;
  }
}
