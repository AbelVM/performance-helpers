import { describe, it, expect, vi } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

describe('PowerCache getOrSet APIs', () => {
  it('getOrSet stores and returns computed sync value', () => {
    const c = new PowerCache({ defaultTTL: 10000 });
    const res = c.getOrSet('a', () => {
      return 42;
    });
    expect(res).toBe(42);
    expect(c.get('a')).toBe(42);
    expect(c.size).toBeGreaterThanOrEqual(1);
    // subsequent calls should return cached value and not invoke factory
    const res2 = c.getOrSet('a', () => {
      throw new Error('should not call');
    });
    expect(res2).toBe(42);
    expect(c.hits).toBeGreaterThanOrEqual(1);
    expect(c.misses).toBeGreaterThanOrEqual(0);
  });

  it('getOrSetAsync deduplicates concurrent async factories', async () => {
    const c = new PowerCache({ defaultTTL: 10000 });
    const asyncFactory = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve('ok'), 20);
      });

    const p1 = c.getOrSetAsync('k', asyncFactory);
    const p2 = c.getOrSetAsync('k', asyncFactory);
    const [v1, v2] = await Promise.all([p1, p2]);
    expect(v1).toBe('ok');
    expect(v2).toBe('ok');
    expect(c.get('k')).toBe('ok');
    expect(c.size).toBeGreaterThanOrEqual(1);
    expect(c._inflightPromises.has('k')).toBe(false);
    expect(c.hits + c.misses).toBeGreaterThanOrEqual(1);
    expect(c.misses).toBeGreaterThanOrEqual(1);
    expect(c._inflightPromises.size).toBe(0);
  });

  it('getOrSetAsync clears inflight on rejection and allows retry', async () => {
    const c = new PowerCache({ defaultTTL: 10000 });
    const badFactory = () => {
      return Promise.reject(new Error('boom'));
    };

    // concurrent callers should receive rejection
    const p1 = c.getOrSetAsync('x', badFactory).catch((e) => e);
    const p2 = c.getOrSetAsync('x', badFactory).catch((e) => e);
    const [e1, e2] = await Promise.all([p1, p2]);
    expect(e1).toBeInstanceOf(Error);
    expect(e2).toBeInstanceOf(Error);
    // ensure inflight cleared
    expect(c._inflightPromises.has('x')).toBe(false);

    // now succeed with a good factory
    const okFactory = () => Promise.resolve('now');
    const v = await c.getOrSetAsync('x', okFactory);
    expect(v).toBe('now');
    expect(c.get('x')).toBe('now');
  });

  it('getOrSet staleWhileRevalidate returns stale value and refreshes in background', async () => {
    let clock = 0;
    const c = new PowerCache({ defaultTTL: 1, now: () => clock });
    c.set('a', 1, { ttl: 1 });
    // Exact now: `PowerCache` takes the same `now` injection the limiters and
    // `PowerTTLMap` do, so the entry goes stale on a number the test chose
    // rather than on a sleep it has to out-wait. This asserted "not yet", which
    // `vi.waitFor` cannot poll for and which a sleep could only approximate.
    clock = 5;

    let resolveRefresh;
    const refreshFactory = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const stale = c.getOrSet('a', refreshFactory, {
      staleWhileRevalidate: true,
      ttl: 10000,
    });

    expect(stale).toBe(1);
    expect(c._inflightPromises.has('a')).toBe(true);

    await vi.waitFor(() => {
      expect(refreshFactory).toHaveBeenCalledTimes(1);
    });

    resolveRefresh(2);
    await c._inflightPromises.get('a');

    expect(c.get('a')).toBe(2);
  });

  it('getOrSetAsync staleWhileRevalidate returns stale value and refreshes in background', async () => {
    let clock = 0;
    const c = new PowerCache({ defaultTTL: 1, now: () => clock });
    c.set('x', 'old', { ttl: 1 });
    clock = 5;

    const asyncFactory = vi.fn(() => Promise.resolve('fresh'));
    const result = await c.getOrSetAsync('x', asyncFactory, {
      staleWhileRevalidate: true,
      ttl: 10000,
    });

    expect(result).toBe('old');
    expect(asyncFactory).toHaveBeenCalledTimes(1);
    await c._inflightPromises.get('x');
    expect(c.get('x')).toBe('fresh');
  });
});

/**
 * TEST-003: a **counter** for the clock `getOrSet` reads.
 *
 * `getOrSet` calls `nowMs()` more than once per call, and `now.js:58-60` puts
 * that at 141 ns on "the hot path of essentially every helper". A test that only
 * asserts the value is correct cannot see that, because the extra read changes
 * no observable result — which is why the row asks for a counter rather than a
 * duration, and why the number has to be pinned as a *characterisation*:
 * PERF-003 has not landed, so asserting the post-fix count would fail the suite
 * and assert an aspiration.
 *
 * Counting is done by wrapping the module's `nowMs` through `vi.mock`, because
 * `powerCache.js` imports it directly and a spy on the module namespace would
 * not be seen by the already-bound import.
 */
describe('TEST-003: getOrSet clock reads', () => {
  it('counts nowMs() calls per getOrSet, as a characterisation of PERF-003', async () => {
    let reads = 0;
    vi.resetModules();
    vi.doMock('../src/utils/now.js', async () => {
      const actual = await vi.importActual('../src/utils/now.js');
      return { ...actual, nowMs: () => ((reads += 1), 1_000) };
    });
    try {
      const { PowerCache: Counted } = await import('../src/helpers/powerCache.js');
      const cache = new Counted({ maxEntries: 10 });
      reads = 0;
      cache.getOrSet('k', () => 'v');
      // **Pinned to 2, which is the number PERF-003 names** — "`getOrSet` and
      // `touch` read the clock twice per call" — so the counter is measuring the
      // documented defect rather than something adjacent to it.
      //
      // The first version asserted `toBeGreaterThanOrEqual(1)`, which accepts
      // every value and is therefore decoration by this repository's own rule.
      // Measured through the same mock: 2 on the miss path, 2 on a second miss.
      // PERF-003 wants 1; when it lands this fails, which is the flip the
      // characterisation exists to make visible.
      expect(reads).toBe(2);
    } finally {
      vi.doUnmock('../src/utils/now.js');
      vi.resetModules();
    }
  });
});
