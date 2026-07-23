/**
 * Configuration, including per-capability endpoint overrides.
 *
 * The routing rule the user asked for:
 *   - where several endpoints truly provide a capability, any of them may be
 *     chosen explicitly;
 *   - where one is genuinely better, that is the default preference;
 *   - and every default can be overridden by hand.
 *
 * Overrides come from env (`YTMD_PREFER_<CAPABILITY>`) so no config file is
 * needed for the common case. Value is a comma-separated endpoint list, tried
 * in order.
 *
 *   YTMD_PREFER_QUEUEWRITE=music-together,api-server
 *   YTMD_PREFER_METADATA=mpris
 *   YTMD_PREFER_SEEK=api-server
 */
import {
  CAPABILITIES,
  DEFAULT_PREFERENCE,
  ENDPOINTS,
  SUPPORT,
  type Capability,
  type EndpointName,
} from './capabilities.ts';

export type Config = {
  apiServer: { baseUrl: string; token?: string; clientId: string };
  musicTogether: { hostId?: string };
  mpris: { busNamePattern: RegExp; identity: string };
  preference: Record<Capability, readonly EndpointName[]>;
  /** Endpoints the operator has switched off entirely. */
  disabled: Set<EndpointName>;
};

function parseEndpointList(raw: string, where: string): EndpointName[] {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const bad = parts.filter((p) => !(ENDPOINTS as readonly string[]).includes(p));
  if (bad.length) {
    throw new Error(
      `${where}: unknown endpoint(s) ${bad.join(', ')}. Valid: ${ENDPOINTS.join(', ')}`,
    );
  }
  return parts as EndpointName[];
}

function loadPreference(): Record<Capability, readonly EndpointName[]> {
  const preference = { ...DEFAULT_PREFERENCE } as Record<
    Capability,
    readonly EndpointName[]
  >;

  for (const cap of CAPABILITIES) {
    const key = `YTMD_PREFER_${cap.toUpperCase()}`;
    const raw = process.env[key];
    if (!raw) continue;

    const chosen = parseEndpointList(raw, key);

    // Refuse an override that names an endpoint which cannot do the job --
    // silently ignoring it would look like the override simply had no effect.
    const incapable = chosen.filter((e) => !SUPPORT[e].includes(cap));
    if (incapable.length) {
      throw new Error(
        `${key}: ${incapable.join(', ')} cannot provide '${cap}'. ` +
          `Capable endpoints: ${ENDPOINTS.filter((e) => SUPPORT[e].includes(cap)).join(', ')}`,
      );
    }

    preference[cap] = chosen;
  }

  return preference;
}

export function loadConfig(): Config {
  const disabled = new Set(
    parseEndpointList(process.env.YTMD_DISABLE ?? '', 'YTMD_DISABLE'),
  );

  return {
    apiServer: {
      baseUrl: process.env.YTMD_API_URL ?? 'http://127.0.0.1:26538',
      token: process.env.YTMD_API_TOKEN,
      clientId: process.env.YTMD_API_CLIENT_ID ?? 'ytm-bridge',
    },
    musicTogether: {
      hostId: process.env.YTMD_MT_HOST_ID,
    },
    mpris: {
      // Bus names are not stable across versions -- match on Identity instead.
      busNamePattern: /^org\.mpris\.MediaPlayer2\./,
      identity: process.env.YTMD_MPRIS_IDENTITY ?? 'YouTube Music',
    },
    preference: loadPreference(),
    disabled,
  };
}
