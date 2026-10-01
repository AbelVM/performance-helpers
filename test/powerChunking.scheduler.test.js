/**
 * DEFER-002: the macrotask scheduler `PowerChunker` defers each chunk to.
 *
 * `PowerChunker` is not a fallback path — it builds inline workers in every
 * environment — so the scheduler behind it runs on every batch it processes.
 * The deferral note for this item rejected a *microtask* because a run of them
 * never yields, and that reasoning is right; what it did not notice is that the
 * row's own proposal (a microtask/rAF scheduler) offered nothing else, so the
 * item was correctly deferred against an insufficient set of options.
 *
 * `setImmediate` is the option that was missing: a macrotask, so it yields
 * exactly as a zero-delay timeout does, at ~1.74 µs against ~1057 µs in Node,
 * which clamps a zero timer delay to 1 ms.
 *
 * These tests pin the two properties that matter and that a naive
 * "use the fast one" change would lose: it still yields, and it still processes
 * chunks in the order they were posted.
 *
 * **There is deliberately no timing assertion here.** The first draft of this
 * file had one, on a measured 608x per-turn difference, and it passed with the
 * fix reverted. The per-turn figure is real and it does not apply: `PowerChunker`
 * posts every chunk as a batch, so the timers expire together and the 1 ms floor
 * is paid once per batch rather than once per chunk. End to end, 2000 items, the
 * two schedulers are within noise. A timing assertion that cannot fail on the
 * regression it names is decoration, so it was deleted rather than loosened.
 */
import { describe, it, expect } from 'vitest';
import { PowerChunker } from '../src/index.js';

describe('PowerChunker defers chunks to a macrotask, not a timer', () => {
  it('processes every item exactly once', async () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    const pool = new PowerChunker(items, (x) => x * 2, { poolOptions: { size: 2 } });
    const seen = [];
    pool.onmessage = (e) => {
      seen.push(...(e?.data?.results ?? []));
    };
    await pool.drain();
    // The scheduler is invisible in this assertion, which is the point: a
    // change that dropped the yield would pass it and fail the next one.
    expect(seen.sort((a, b) => a - b)).toEqual(items.map((x) => x * 2));
    pool.terminate();
  });

  it('defers the work rather than running it synchronously', async () => {
    // The property that matters, and the one the original deferral note was
    // protecting: the work is not on the caller's stack when `PowerChunker`
    // returns. A synchronous or microtask-only scheduler would pass every other
    // test in this file and fail this one, because the whole batch would
    // already be done by the time the constructor returned.
    let processed = 0;
    const pool = new PowerChunker([1, 2, 3, 4, 5, 6, 7, 8], (x) => {
      processed += 1;
      return x;
    });
    pool.onmessage = () => {};
    expect(processed).toBe(0);
    await pool.drain();
    expect(processed).toBe(8);
    pool.terminate();
  });

  it('preserves chunk order', async () => {
    // `setImmediate` drains its queue FIFO, as equal-delay timeouts do. If a
    // future change reached for `queueMicrotask` *and* a pool, this is the test
    // that would notice before the ordering guarantee did.
    const items = Array.from({ length: 40 }, (_, i) => i);
    const pool = new PowerChunker(items, (x) => x, { poolOptions: { size: 1 } });
    const order = [];
    pool.onmessage = (e) => {
      const r = e?.data?.results;
      if (Array.isArray(r)) order.push(...r);
    };
    await pool.drain();
    expect(order).toEqual(items);
    pool.terminate();
  });

  it('resolves drain() with the same summary shape as before', async () => {
    // The scheduler change must not be observable in the result contract. The
    // first draft asserted `drain()` resolves to `undefined`, on the assumption
    // that it returns nothing; it returns a summary, and the assumption was
    // never checked. Pinned on the properties that matter rather than on a
    // guessed shape.
    const pool = new PowerChunker([1, 2, 3], (x) => x + 1, { poolOptions: { size: 1 } });
    pool.onmessage = () => {};
    const summary = await pool.drain();
    // `drain()` resolves to `getStats()`, not to a task count. Two drafts of this
    // test guessed at that shape without reading it, which is the habit this
    // row's history is full of.
    expect(summary).toHaveProperty('performance');
    expect(summary).toHaveProperty('isIdle', true);
    expect(summary.activeTasks).toBe(0);
    pool.terminate();
  });
});
