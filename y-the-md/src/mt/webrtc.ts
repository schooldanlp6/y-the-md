/**
 * WebRTC polyfill for Bun.
 *
 * PeerJS is a browser library: it expects RTCPeerConnection and friends as
 * globals. Bun has no built-in WebRTC, so `node-datachannel/polyfill` supplies
 * a spec-shaped implementation and we install it globally before PeerJS loads.
 * It is a native module, loaded through Bun's N-API support.
 *
 * This is the project's only non-pure-JS dependency (node-datachannel ships
 * prebuilt binaries for common platforms). See AGENTS.md constraint 7.
 */

let installed = false;

export async function installWebRTC(): Promise<void> {
  if (installed) return;

  const polyfill = await import('node-datachannel/polyfill');

  const globals: Record<string, unknown> = {
    RTCPeerConnection: polyfill.RTCPeerConnection,
    RTCSessionDescription: polyfill.RTCSessionDescription,
    RTCIceCandidate: polyfill.RTCIceCandidate,
    RTCDataChannel: polyfill.RTCDataChannel,
    RTCCertificate: polyfill.RTCCertificate,
  };

  for (const [name, value] of Object.entries(globals)) {
    if (value && !(name in globalThis)) {
      Object.defineProperty(globalThis, name, {
        value,
        writable: true,
        configurable: true,
      });
    }
  }

  // PeerJS also needs a WebSocket to reach the signalling broker. Bun has
  // shipped a global WebSocket since 1.0, so this should never fire.
  if (typeof globalThis.WebSocket === 'undefined') {
    throw new Error('No global WebSocket available in this runtime.');
  }

  installed = true;
}

/** Release native resources so the process can exit cleanly. */
export async function cleanupWebRTC(): Promise<void> {
  if (!installed) return;
  try {
    const nd = await import('node-datachannel');
    nd.cleanup?.();
  } catch {
    // Nothing to clean up if the module never loaded.
  }
}
