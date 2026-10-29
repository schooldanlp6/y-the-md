/**
 * Guest-side Music Together connection.
 *
 * We are a *guest*, never a host: a pear-desktop instance hosts the session and
 * shares its raw PeerJS id (the plugin copies it to the clipboard). We connect
 * to that id and speak the plugin's event protocol.
 *
 * There is no server here. Transport is P2P WebRTC; only the initial handshake
 * goes through PeerJS's public broker.
 */
// Type-only: erased at runtime, so it cannot trigger module evaluation.
// PeerJS feature-detects WebRTC when its module body runs, so the real import
// must happen *after* installWebRTC() -- see connect().
import type { DataConnection, Peer } from 'peerjs';

import {
  ICE_SERVERS,
  isKnownEvent,
  type ConnectionEvent,
  type ConnectionEventMap,
  type ConnectionEventUnion,
  type Permission,
  type Profile,
} from './protocol.ts';
import { installWebRTC } from './webrtc.ts';

export type Handlers = {
  [E in ConnectionEvent]?: (payload: ConnectionEventMap[E]) => void;
};

export type ConnectionOptions = {
  /** Host peer id, as copied out of pear-desktop's Music Together UI. */
  hostId: string;
  /** Identity we announce to the session. */
  profile: Profile;
  /** Called for event types the plugin sent but we don't model. */
  onUnknown?: (type: string, payload: unknown) => void;
  onOpen?: (selfId: string) => void;
  onClose?: (reason: string) => void;
  onError?: (error: Error) => void;
  /** Seconds to wait for the data connection before giving up. */
  timeoutMs?: number;
};

export class MusicTogetherGuest {
  private peer?: Peer;
  private conn?: DataConnection;
  private handlers: Handlers = {};
  private permission?: Permission;

  constructor(private readonly options: ConnectionOptions) {}

  /**
   * Latest permission the host granted us.
   *
   * MEASURED 2026-07-21 against pear-desktop 3.12.0: the host never sends a
   * PERMISSION event to a joining guest at all, yet guest writes are honoured
   * anyway -- a SYNC_PROGRESS with state=PAUSED took effect within 1s and held
   * until a human pressed play. So this stays undefined in practice and must
   * NOT be used as a gate on writing -- treat it as advisory only.
   */
  get grantedPermission(): Permission | undefined {
    return this.permission;
  }

  /**
   * Whether the host has explicitly granted write access.
   *
   * Note this reports false in the observed default case even though writes
   * *do* work. Use it for reporting, not for deciding whether to send.
   */
  get hasExplicitWriteGrant(): boolean {
    return this.permission === 'playlist' || this.permission === 'all';
  }

  on<E extends ConnectionEvent>(
    type: E,
    handler: (payload: ConnectionEventMap[E]) => void,
  ): this {
    this.handlers[type] = handler as Handlers[E];
    return this;
  }

  async connect(): Promise<void> {
    // Order matters: PeerJS decides whether WebRTC "is supported" while its
    // module body executes, so the globals must exist first. A static import
    // would run too early and fail with "browser does not support WebRTC".
    await installWebRTC();
    const { Peer: PeerCtor } = await import('peerjs');

    const { hostId, profile, timeoutMs = 30_000 } = this.options;

    this.peer = new PeerCtor({
      config: { iceServers: ICE_SERVERS },
      debug: 0,
    });

    const selfId = await this.waitForPeerOpen(this.peer, timeoutMs);
    this.options.onOpen?.(selfId);

    const conn = this.peer.connect(hostId, { reliable: true });
    this.conn = conn;

    await this.waitForConnOpen(conn, this.peer, timeoutMs);

    conn.on('data', (data) => this.dispatch(data));
    conn.on('close', () => this.options.onClose?.('peer closed the connection'));
    conn.on('error', (err) => this.options.onError?.(toError(err)));

    // Announce ourselves; the host answers with SYNC_PROFILE and PERMISSION.
    this.send('IDENTIFY', { profile });
  }

  send<E extends ConnectionEvent>(type: E, payload: ConnectionEventMap[E]): void {
    if (!this.conn?.open) {
      throw new Error(`cannot send ${type}: connection is not open`);
    }
    this.conn.send({ type, payload } satisfies ConnectionEventUnion);
  }

  close(): void {
    this.conn?.close();
    this.peer?.destroy();
  }

  private dispatch(data: unknown): void {
    if (!data || typeof data !== 'object') return;

    const { type, payload, after } = data as {
      type?: unknown;
      payload?: unknown;
      after?: unknown[];
    };

    if (!isKnownEvent(type)) {
      // Loud, not silent: the protocol is plugin-internal and may drift between
      // pear-desktop releases. See AGENTS.md constraint 7.
      this.options.onUnknown?.(String(type), payload);
      return;
    }

    if (type === 'PERMISSION') {
      this.permission = payload as Permission | undefined;
    }

    const handler = this.handlers[type] as ((p: unknown) => void) | undefined;
    handler?.(payload);

    // Chained follow-up events ride along in `after`.
    if (Array.isArray(after)) {
      for (const nested of after) this.dispatch(nested);
    }
  }

  private waitForPeerOpen(peer: Peer, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`broker did not assign an id within ${timeoutMs}ms`)),
        timeoutMs,
      );
      peer.once('open', (id) => {
        clearTimeout(timer);
        resolve(id);
      });
      peer.once('error', (err) => {
        clearTimeout(timer);
        reject(toError(err));
      });
    });
  }

  private waitForConnOpen(conn: DataConnection, peer: Peer, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `host did not accept the connection within ${timeoutMs}ms — ` +
                'is the session still open and the id current?',
            ),
          ),
        timeoutMs,
      );
      conn.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      conn.once('error', (err) => {
        clearTimeout(timer);
        reject(toError(err));
      });
      // An unknown host id is reported on the *peer*, not the connection, so
      // without this an expired id sits out the whole timeout in silence.
      peer.on('error', (err: Error & { type?: string }) => {
        if (err?.type !== 'peer-unavailable') return;
        clearTimeout(timer);
        reject(
          new Error(
            `no Music Together host with id ${this.options.hostId} — ` +
              'the session has ended or the id is from an old session',
          ),
        );
      });
    });
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
