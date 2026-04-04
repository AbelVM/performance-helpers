import { describe, it, expect } from 'vitest';
import { PowerMemoizer } from '../src/helpers/powerCache.js';

describe('PowerMemoizer.memoize', () => {
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
    expect(typeof memo.clear).toBe('function');
    memo.clear();
    expect(memo(1)).toBe(2);
    expect(calls).toBe(2);
  });

  it('memoized function is instanceof PowerMemoizer', () => {
    const pm = new PowerMemoizer();
    const memo = pm.memoize((x) => x);
    expect(memo instanceof PowerMemoizer).toBe(true);
  });

  it('honors per-wrapper ttl and weight options', async () => {
    // TTL override
    let calls = 0;
    const fn = (x) => {
      calls++;
      return x;
    };
    const pm = new PowerMemoizer();
    const memo = pm.memoize(fn, { ttl: 5 });
    expect(memo(1)).toBe(1);
    expect(calls).toBe(1);
    expect(memo(1)).toBe(1);
    expect(calls).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
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
});
