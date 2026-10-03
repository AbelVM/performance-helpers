import { describe, it, expect } from 'vitest';
import { PowerMemoizer } from '../src/helpers/powerCache.js';

describe('PowerMemoizer.memoize', () => {
  it('throws when memoize is called with a non-function', () => {
    const pm = new PowerMemoizer();
    expect(() => pm.memoize(null)).toThrow(TypeError);
  });

  it('memoizes sync function via memoize() and attaches helpers', () => {
    let calls = 0;
    const fn = (x) => {
      calls++;
      return x + 1;
    };
    const pm = new PowerMemoizer();
    const memo = pm.memoize(fn);
    expect(memo(1)).toBe(2);
    expect(calls).toBe(1);
    expect(memo(1)).toBe(2);
    expect(calls).toBe(1);
    // helpers
    expect(typeof memo.get).toBe('function');
    expect(memo.get(1)).toBe(2);
    expect(typeof memo.has).toBe('function');
    expect(memo.has(1)).toBe(true);
    expect(typeof memo.delete).toBe('function');
    expect(memo.delete(1)).toBe(true);
    expect(memo.has(1)).toBe(false);
    expect(typeof memo.stats).toBe('function');
    expect(memo.stats()).toHaveProperty('size');
    expect(memo.cache).toBe(pm.cache);
    expect(memo.original).toBe(fn);
    expect(typeof memo.clear).toBe('function');
    memo.clear();
    expect(memo(1)).toBe(2);
    expect(calls).toBe(2);
  });

  it('memoized function is a real Function with a working prototype chain', () => {
    const pm = new PowerMemoizer();
    const memo = pm.memoize((x) => x);
    // The memoized wrapper used to be re-prototyped onto
    // `PowerMemoizer.prototype`, whose chain ends at `Object.prototype`. That
    // removed `Function.prototype` and silently stripped `.call`/`.apply`/
    // `.bind` from the returned function. Brand via the own properties
    // instead of prototype surgery.
    expect(typeof memo).toBe('function');
    expect(typeof memo.call).toBe('function');
    expect(typeof memo.apply).toBe('function');
    expect(typeof memo.bind).toBe('function');
    expect(memo.call(null, 7)).toBe(7);
    expect(memo(7)).toBe(7);
    expect(memo.original).toBe(pm._fn ?? memo.original);
  });

  it('memoized function supports .call with a custom receiver and binding', () => {
    const pm = new PowerMemoizer();
    const memo = pm.memoize(function (x) {
      return x + (this?.offset ?? 0);
    });
    expect(memo.call({ offset: 10 }, 5)).toBe(15);
    expect(memo.apply({ offset: 2 }, [5])).toBe(7);
  });

  it('honors per-wrapper ttl and weight options', async () => {
    // TTL override, on an injected clock rather than a sleep.
    //
    // This was `await setTimeout(10)` against a 5 ms TTL, which passed 12 times
    // in isolation and then failed inside the full suite as `expected 2 to be 1`
    // — the entry had not expired. Wall-clock expiry is a duration assertion,
    // and this harness measures a ~28 % median spread, so it is noise dressed as
    // a check: under load the sleep and the cache's idea of "now" disagree. The
    // property being tested is that a TTL is *consulted*, which a mutable clock
    // settles exactly and instantly.
    let calls = 0;
    const fn = (x) => {
      calls++;
      return x;
    };
    let t = 1000;
    const pm = new PowerMemoizer(undefined, { cacheOptions: { now: () => t } });
    const memo = pm.memoize(fn, { ttl: 5 });
    expect(memo(1)).toBe(1);
    expect(calls).toBe(1);
    expect(memo(1)).toBe(1);
    expect(calls).toBe(1);
    // Still inside the 5 ms window, one tick before expiry.
    t += 4;
    expect(memo(1)).toBe(1);
    expect(calls).toBe(1);
    // Past it.
    t += 2;
    expect(memo(1)).toBe(1);
    expect(calls).toBe(2);

    // Weight override with rejection by cache
    let calls2 = 0;
    const fn2 = (x) => {
      calls2++;
      return { v: x };
    };
    const pm2 = new PowerMemoizer(undefined, {
      cacheOptions: { maxWeight: 1, rejectOversized: true },
    });
    const memo2 = pm2.memoize(fn2, { weight: 2 });
    // first call returns value but should not be cached due to oversized weight
    const a = memo2(1);
    expect(a).toEqual({ v: 1 });
    expect(calls2).toBe(1);
    // second call should invoke original again because caching was rejected
    const b = memo2(1);
    expect(b).toEqual({ v: 1 });
    expect(calls2).toBe(2);
  });

  it('uses constructor default memoize options when per-call ttl/weight are omitted', async () => {
    // Same injected clock as above, for the same reason: this was a 10 ms sleep
    // against a 5 ms constructor TTL, and it is the assertion that failed under
    // suite load.
    let calls = 0;
    let t = 1000;
    const pm = new PowerMemoizer(undefined, { ttl: 5, cacheOptions: { now: () => t } });
    const memo = pm.memoize((value) => {
      calls += 1;
      return value;
    });

    expect(memo('x')).toBe('x');
    expect(memo('x')).toBe('x');
    expect(calls).toBe(1);

    t += 6;

    expect(memo('x')).toBe('x');
    expect(calls).toBe(2);
  });
});
