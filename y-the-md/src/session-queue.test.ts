import { describe, expect, test } from 'bun:test';

import type { Endpoint, QueueSnapshot } from './endpoints/types.ts';
import type { Router } from './router.ts';
import { SessionQueue } from './session-queue.ts';

/** A queue that applies inserts immediately, behind a router-shaped facade. */
function fakeSession(videoIds: string[], currentIndex: number) {
  const state = {
    items: videoIds.map((videoId) => ({ videoId })),
    currentIndex,
    /** When false, inserts are "sent" but never land. */
    lands: true,
    writes: 0,
  };
  const endpoint: Partial<Endpoint> = {
    name: 'api-server',
    queue: async (): Promise<QueueSnapshot> => ({
      items: state.items.map((it) => ({ ...it })),
      currentIndex: state.currentIndex,
    }),
    insertAt: async (videoId: string, index: number) => {
      state.writes += 1;
      if (!state.lands) return false;
      state.items.splice(index, 0, { videoId });
      return true;
    },
  };
  const router = { resolve: () => endpoint as Endpoint } as unknown as Router;
  return { state, router, order: () => state.items.map((it) => it.videoId) };
}

describe('SessionQueue', () => {
  test('consecutive adds play in the order they were added', async () => {
    const s = fakeSession(['cur', 'auto1', 'auto2'], 0);
    const q = new SessionQueue(s.router);

    await q.add('a');
    await q.add('b');
    await q.add('c');

    expect(s.order()).toEqual(['cur', 'a', 'b', 'c', 'auto1', 'auto2']);
  });

  test('the first add goes straight after the current track', async () => {
    const s = fakeSession(['p0', 'cur', 'auto1'], 1);
    const { index } = await new SessionQueue(s.router).add('a');

    expect(index).toBe(2);
    expect(s.order()).toEqual(['p0', 'cur', 'a', 'auto1']);
  });

  test('adds that already played are forgotten', async () => {
    const s = fakeSession(['cur', 'auto1'], 0);
    const q = new SessionQueue(s.router);

    await q.add('a'); // cur, a, auto1
    s.state.currentIndex = 1; // 'a' is now playing

    await q.add('b');
    expect(s.order()).toEqual(['cur', 'a', 'b', 'auto1']);
  });

  test('an add removed by someone else no longer anchors the next one', async () => {
    const s = fakeSession(['cur', 'auto1'], 0);
    const q = new SessionQueue(s.router);

    await q.add('a'); // cur, a, auto1
    s.state.items.splice(1, 1); // someone removed 'a'

    await q.add('b');
    expect(s.order()).toEqual(['cur', 'b', 'auto1']);
  });

  test('an earlier add moved far back does not drag later adds after it', async () => {
    const s = fakeSession(['cur', 'auto1', 'auto2'], 0);
    const q = new SessionQueue(s.router);

    await q.add('a');
    await q.add('b'); // cur, a, b, auto1, auto2
    // Someone moved 'a' behind all of autoplay.
    const [a] = s.state.items.splice(1, 1);
    s.state.items.push(a!);

    await q.add('c');
    expect(s.order()).toEqual(['cur', 'b', 'c', 'auto1', 'auto2', 'a']);
  });

  test('a repeated key is answered from the queue, not inserted again', async () => {
    const s = fakeSession(['cur', 'auto1'], 0);
    const q = new SessionQueue(s.router);

    const first = await q.add('a', 'k1');
    const again = await q.add('a', 'k1');

    expect(s.state.writes).toBe(1);
    expect(again).toEqual({ index: first.index, confirmed: true, duplicate: true });
    expect(s.order()).toEqual(['cur', 'a', 'auto1']);
  });

  test('a repeat right after the track played does not bring it back', async () => {
    const s = fakeSession(['cur', 'auto1'], 0);
    const q = new SessionQueue(s.router);

    await q.add('a', 'k1');
    s.state.currentIndex = 1; // 'a' is playing now, so no longer ahead

    const again = await q.add('a', 'k1');
    expect(again.duplicate).toBe(true);
    expect(s.state.writes).toBe(1);
  });

  test('an unconfirmed insert is re-checked, and only rewritten if absent', async () => {
    const s = fakeSession(['cur', 'auto1'], 0);
    const q = new SessionQueue(s.router);

    s.state.lands = false;
    expect((await q.add('a', 'k1')).confirmed).toBe(false);

    // It landed late after all: the retry must find it, not add a copy.
    s.state.items.splice(1, 0, { videoId: 'a' });
    const found = await q.add('a', 'k1');
    expect(found).toMatchObject({ confirmed: true, duplicate: true, index: 1 });
    expect(s.state.writes).toBe(1);
  });

  test('an unconfirmed insert that never landed is written again', async () => {
    const s = fakeSession(['cur', 'auto1'], 0);
    const q = new SessionQueue(s.router);

    s.state.lands = false;
    await q.add('a', 'k1');
    s.state.lands = true;

    expect(await q.add('a', 'k1')).toEqual({ index: 1, confirmed: true });
    expect(s.order()).toEqual(['cur', 'a', 'auto1']);
  });

  test('the same track under a different key is a separate add', async () => {
    const s = fakeSession(['cur', 'auto1'], 0);
    const q = new SessionQueue(s.router);

    await q.add('a', 'k1');
    await q.add('a', 'k2');
    expect(s.order()).toEqual(['cur', 'a', 'a', 'auto1']);
  });

  test('refuses when the queue has no current track', async () => {
    const s = fakeSession([], -1);
    s.state.currentIndex = undefined as unknown as number;
    await expect(new SessionQueue(s.router).add('a')).rejects.toThrow('no current track');
  });
});
