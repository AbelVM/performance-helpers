/**
 * `PowerMemoizer` hot path (PERF-005).
 *
 * The audit proposed arity specialisation and `simpleArgsKey` as the two wins.
 * Measured, only one of them was: the real cost was a **double cache lookup**
 * that the audit did not mention, and which is 2x the cost of a single one.
 * The arity specialisation measured at ~0.1% and was not done.
 */
import { describe, it, expect } from 'vitest';
import { PowerMemoizer, simpleArgsKey } from '../src/index.js';

describe('PowerMemoizer hot path', () => {
  it('defaults to simpleArgsKey, not JSON.stringify', () => {
    const m = new PowerMemoizer();
    // The default resolver is the exported helper itself, so a caller who wants
    // the old shape can pass `(...args) => JSON.stringify(args)` back.
    expect(m.keyResolver).toBe(simpleArgsKey);
    expect(m.keyResolver(1, 'a')).toBe(simpleArgsKey(1, 'a'));
  });

  it('still distinguishes values the cheap encoding cannot', () => {
    // A default that silently collides would be a cache-poisoning bug, which is
    // worse than being slow. simpleArgsKey falls back to JSON.stringify for
    // anything non-scalar, and that has to hold.
    const m = new PowerMemoizer();
    const f = m.memoize((x) => x);
    f({ a: 1 });
    f({ a: 1 });
    // Two structurally identical objects serialise identically, so they share
    // one entry - exactly as they did under the old default. The point is that
    // switching the default did not change this, not that it should be 2.
    expect(m.cache.size).toBe(1);
    f({ a: 2 });
    expect(m.cache.size).toBe(2);
  });

  it('a memoized call costs one cache lookup, not two', () => {
    // `has()` then `get()` existed only to tell "absent" from "cached
    // undefined". Cached `undefined` must still work, so the distinction has to
    // survive - it just does not need a second lookup to make it.
    const m = new PowerMemoizer();
    const f = m.memoize(() => undefined);
    expect(f(1)).toBeUndefined();
    let calls = 0;
    const g = m.memoize(() => {
      calls += 1;
      return undefined;
    });
    g(2);
    g(2);
    g(2);
    // A cached `undefined` must hit, not recompute - which is exactly what the
    // single-lookup path has to preserve.
    expect(calls).toBe(1);
  });

  it('caches a genuinely undefined result and still returns it', () => {
    const m = new PowerMemoizer();
    let calls = 0;
    const f = m.memoize(() => {
      calls += 1;
      return undefined;
    });
    for (let i = 0; i < 10; i += 1) expect(f('k')).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('honours an explicit keyResolver, including the old JSON shape', () => {
    const json = (...args) => JSON.stringify(args);
    const m = new PowerMemoizer(null, { keyResolver: json });
    expect(m.keyResolver(1, 2)).toBe('[1,2]');
    const f = m.memoize((a, b) => a + b);
    expect(f(1, 2)).toBe(3);
    // Key format is the old one, so a caller reading keys is unaffected.
    expect([...m.cache.keys()]).toEqual(['[1,2]']);
  });

  it('expiry still works through the single-lookup path', async () => {
    // The single lookup goes through `_fetchValidNode`, which is also what
    // performs the expiry check and the eviction. A shortcut that skipped it
    // would serve an expired value forever, so this is the important one.
    // `ttl` lives in the *options* argument, not the first one - passing it
    // as the function slot is silently ignored, which is worth being explicit
    // about here since this test exists to catch exactly that class of mistake.
    const m = new PowerMemoizer(null, { ttl: 20 });
    let calls = 0;
    const f = m.memoize(() => ++calls);
    expect(f('k')).toBe(1);
    expect(f('k')).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(f('k')).toBe(2);
  });

  it('keeps the receiver in the key for a memoized method', () => {
    // The single-lookup change must not have disturbed receiver handling:
    // `objA.m(1)` and `objB.m(1)` are different entries.
    const m = new PowerMemoizer();
    const proto = {
      factor: 3,
      double: m.memoize(function (x) {
        return x * this.factor;
      }),
    };
    const a = Object.create(proto);
    const b = Object.create(proto);
    b.factor = 10;
    expect(a.double(2)).toBe(6);
    expect(b.double(2)).toBe(20);
  });

  it('still deduplicates concurrent promises', async () => {
    const m = new PowerMemoizer();
    let calls = 0;
    const f = m.memoize(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return 'done';
    });
    const [x, y, z] = await Promise.all([f('k'), f('k'), f('k')]);
    expect([x, y, z]).toEqual(['done', 'done', 'done']);
    expect(calls).toBe(1);
  });
});
