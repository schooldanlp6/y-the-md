/**
 * Ordered, idempotent inserts into the shared YouTube Music queue.
 *
 * **Order.** Tracks queued by other participants (via matcha) must play in the
 * order they were added. Inserting each at `currentIndex + 1` -- the only
 * reachable slot under autoplay (AGENTS.md constraint 7) -- would play them in
 * *reverse*: every new add jumps ahead of the previous one. So each add goes
 * straight after the most recent bridge add that is still waiting to play.
 *
 * **Idempotency.** An add can be asked for twice: matcha retries when our
 * confirmation was late (the write may have landed anyway), and listeners in
 * one Spotify Jam each forward the same track. matcha tags every add with a
 * key; a repeat of a key we already placed is answered from what is in the
 * queue instead of inserting a second copy.
 *
 * Nothing here is reconciled: both lists are re-checked against the live
 * queue on every add, so tracks that played or were removed drop out.
 */
import type { Endpoint } from './endpoints/types.ts';
import type { Router } from './router.ts';

export type AddResult = {
  index: number;
  /** False if the write went out but was not seen to land; ask again to re-check. */
  confirmed: boolean;
  /** This key was already placed; nothing new was written. */
  duplicate?: boolean;
};

type Attempt = { videoId: string; at: number; index: number; confirmed: boolean };

/**
 * A repeat of a confirmed key inside this window is a duplicate even if the
 * track has since played or been removed -- resurrecting it would be wrong.
 */
const DUPLICATE_WINDOW_MS = 60_000;
/** Attempts older than this are forgotten; a later add is a genuine re-queue. */
const ATTEMPT_TTL_MS = 10 * 60_000;

export class SessionQueue {
  /** videoIds we inserted, oldest first, that may still be waiting to play. */
  private pending: string[] = [];
  private attempts = new Map<string, Attempt>();

  constructor(private readonly router: Router) {}

  async add(videoId: string, key?: string): Promise<AddResult> {
    // One endpoint for the read and the write, and no fallback in between:
    // indexes are only meaningful on the endpoint that produced them, and
    // falling back after a write that may have half-happened inserts twice.
    const endpoint = this.writer();
    const snapshot = await endpoint.queue!();
    const current = snapshot?.currentIndex;
    if (!snapshot || current === undefined) {
      throw new Error('queue not readable yet (no current track)');
    }

    // Last index ahead of the current track for each videoId.
    const ahead = new Map<string, number>();
    snapshot.items.forEach((item, i) => {
      if (i > current && item.videoId) ahead.set(item.videoId, i);
    });

    const now = Date.now();
    for (const [k, a] of this.attempts) if (now - a.at > ATTEMPT_TTL_MS) this.attempts.delete(k);

    const prior = key !== undefined ? this.attempts.get(key) : undefined;
    if (prior) {
      const at = ahead.get(prior.videoId);
      if (at !== undefined) {
        prior.confirmed = true;
        return { index: at, confirmed: true, duplicate: true };
      }
      if (prior.confirmed && now - prior.at < DUPLICATE_WINDOW_MS) {
        return { index: prior.index, confirmed: true, duplicate: true };
      }
      // Never seen to land and not there now: writing it again is safe.
    }

    this.pending = this.pending.filter((id) => ahead.has(id));
    // Anchor on the most recent add still waiting, not the furthest one: if
    // someone moved an earlier add far back, following it there would bury
    // this one behind autoplay.
    const latest = this.pending.at(-1);
    const index = (latest !== undefined ? ahead.get(latest)! : current) + 1;

    const confirmed = await endpoint.insertAt!(videoId, index);
    // Recorded even unconfirmed: it may yet land, and the next add of this
    // key must look for it before writing again.
    if (key !== undefined) this.attempts.set(key, { videoId, at: now, index, confirmed });
    this.pending.push(videoId);
    return { index, confirmed };
  }

  private writer(): Endpoint {
    const endpoint = this.router.resolve('queueWrite');
    if (!endpoint?.queue || !endpoint.insertAt) {
      throw new Error(
        `no endpoint can both read and insert into the queue (have: ${endpoint?.name ?? 'none'})`,
      );
    }
    return endpoint;
  }
}
