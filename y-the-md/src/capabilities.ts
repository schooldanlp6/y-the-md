/**
 * Capability model.
 *
 * The YouTube Music side is reachable through three independent hooks. They
 * overlap on some capabilities and are unique on others, so nothing here is
 * hardcoded to a hook: callers ask for a *capability* and the router picks an
 * endpoint. See AGENTS.md constraint 9.
 */

export const CAPABILITIES = [
  'transport', // play / pause / next / previous
  'seek', // jump to a position
  'position', // current position + play state
  'metadata', // title / artist / album / duration for the current track
  'queueRead', // the upcoming tracks
  'queueWrite', // insert / move / remove
  'reach', // affects OTHER listeners, not just this machine
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const ENDPOINTS = ['music-together', 'api-server', 'mpris'] as const;
export type EndpointName = (typeof ENDPOINTS)[number];

/**
 * Which endpoint can serve which capability.
 *
 * Measured, not assumed — see AGENTS.md constraint 9 for the evidence behind
 * each cell.
 */
export const SUPPORT: Record<EndpointName, readonly Capability[]> = {
  'music-together': ['transport', 'seek', 'position', 'queueRead', 'queueWrite', 'reach'],
  'api-server': ['transport', 'seek', 'position', 'metadata', 'queueRead', 'queueWrite'],
  mpris: ['transport', 'seek', 'position', 'metadata'],
};

/**
 * Default preference order per capability, best first.
 *
 * Rationale:
 *  - `reach` has exactly one provider; it is a single point of failure.
 *  - Anything affecting what *everyone* hears prefers music-together, so the
 *    whole session stays consistent.
 *  - `metadata` prefers api-server: music-together carries only a videoId, and
 *    MPRIS metadata is thinner than `GET /song`.
 *  - `queueWrite` prefers api-server despite music-together working, because
 *    `INSERT_AFTER_CURRENT_VIDEO` is an explicit, documented enum rather than
 *    an index we compute and hope is still current.
 */
export const DEFAULT_PREFERENCE: Record<Capability, readonly EndpointName[]> = {
  reach: ['music-together'],
  transport: ['music-together', 'api-server', 'mpris'],
  seek: ['music-together', 'api-server', 'mpris'],
  position: ['music-together', 'api-server', 'mpris'],
  metadata: ['api-server', 'mpris'],
  queueRead: ['api-server', 'music-together'],
  queueWrite: ['api-server', 'music-together'],
};

/** True redundancy: more than one endpoint genuinely provides this. */
export function providersFor(capability: Capability): EndpointName[] {
  return ENDPOINTS.filter((e) => SUPPORT[e].includes(capability));
}

export function isRedundant(capability: Capability): boolean {
  return providersFor(capability).length > 1;
}
