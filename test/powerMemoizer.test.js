import { describe, it, expect } from 'vitest';
import { PowerMemoizer } from '../src/helpers/powerCache.js';

describe('PowerMemoizer', () => {
  it('caches sync function results', () => {
    let calls = 0;
    const fn = (a) => {
      calls++;
      return a * 2;
    };
    const pm = new PowerMemoizer();
    const memo = pm.memoize(fn);
    expect(memo(2)).toBe(4);
    expect(calls).toBe(1);
    expect(memo(2)).toBe(4);
    expect(calls).toBe(1);
  });

  it('dedupes concurrent async calls and caches result', async () => {
    let calls = 0;
    const fn = async (x) => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return x * 3;
    };
    const pm = new PowerMemoizer();
    const memo = pm.memoize(fn);
    const p1 = memo(3);
    const p2 = memo(3);
    // same in-flight promise
    expect(p1).toBe(p2);
    const res = await p1;
    expect(res).toBe(9);
    expect(calls).toBe(1);
    // subsequent call returns cached value (not a new invocation)
    const r2 = await Promise.resolve(memo(3));
    expect(r2).toBe(9);
    expect(calls).toBe(1);
  });

  it('does not cache rejected promises', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 1));
      throw new Error('boom');
    };
    const pm = new PowerMemoizer();
    const memo = pm.memoize(fn);
    await expect(memo()).rejects.toThrow('boom');
    await expect(memo()).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });

  it('honors TTL and expires entries', async () => {
    let calls = 0;
    const fn = (x) => {
      calls++;
      return x;
    };
    const pm = new PowerMemoizer(undefined, { ttl: 5 });
    const memo = pm.memoize(fn);
    expect(memo(1)).toBe(1);
    expect(calls).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(memo(1)).toBe(1);
    expect(calls).toBe(2);
  });

  it('delete and clear remove cached entries', () => {
    let calls = 0;
    const fn = (x) => {
      calls++;
      return x;
    };
    const pm = new PowerMemoizer();
    const memo = pm.memoize(fn);
    expect(memo(5)).toBe(5);
    memo.delete(5);
    expect(memo(5)).toBe(5);
    expect(calls).toBe(2);
    memo.clear();
    expect(memo(6)).toBe(6);
  });
});
