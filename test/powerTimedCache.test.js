import { describe, it, expect } from 'vitest';
import { PowerTimedCache, simpleArgsKey } from '../src/helpers/powerCache.js';

describe('PowerTimedCache convenience wrapper', () => {
  it('throws when ttl is not a positive number', () => {
    expect(() => new PowerTimedCache(0)).toThrow('ttl must be a positive number');
    expect(() => new PowerTimedCache(-1)).toThrow('ttl must be a positive number');
  });

  it('auto-starts cleanup and expires entries', async () => {
    const tc = new PowerTimedCache(5, { maxEntries: 10, interval: 5 });
    tc.set('a', 1);
    // wait long enough for TTL (5ms) + cleanup tick
    await new Promise((r) => setTimeout(r, 20));
    expect(tc.get('a')).toBeUndefined();
    tc.stopCleanup();
  });

  it('respects maxEntries forwarded to underlying cache', () => {
    const tc = new PowerTimedCache(1000, { maxEntries: 2 });
    tc.set('a', 1);
    tc.set('b', 2);
    tc.set('c', 3);
    expect(tc.size).toBeLessThanOrEqual(2);
    tc.stopCleanup();
  });

  it('delegates common cache methods and iterators', () => {
    const tc = new PowerTimedCache(1000, { maxEntries: 5 });

    tc.set('a', 1);
    tc.set('b', 2);

    expect(tc.has('a')).toBe(true);
    expect(tc.get('a')).toBe(1);
    expect(tc.hitRate).toBeGreaterThan(0);
    expect(Array.from(tc.keys('MRU')).length).toBe(tc.size);
    expect(Array.from(tc.values('LRU')).length).toBe(tc.size);
    expect(Array.from(tc.entries('MRU')).length).toBe(tc.size);
    expect(tc.stats().size).toBe(tc.size);

    expect(tc.delete('a')).toBe(true);
    tc.clear();
    expect(tc.size).toBe(0);
    tc.stopCleanup();
  });

  it('forwards cleanup controls and disposal hooks', async () => {
    const tc = new PowerTimedCache(1000, { interval: 1000 });
    tc.stopCleanup();
    tc.startCleanup({ interval: 1000, maxCleanupPerTick: 1 });
    expect(tc.cache._cleanupTimer).toBeTruthy();

    tc[Symbol.dispose]();
    expect(tc.cache._cleanupTimer).toBeNull();

    tc.startCleanup(1000);
    await tc[Symbol.asyncDispose]();
    expect(tc.cache._cleanupTimer).toBeNull();
  });
});

describe('simpleArgsKey', () => {
  it('builds deterministic keys for scalar arguments', () => {
    expect(simpleArgsKey()).toBe('');
    expect(simpleArgsKey('ab', 3, true, undefined, null)).toBe('s:2:ab|d:3|b:1|u:|n:');
  });

  it('encodes non-scalar arguments structurally, not as JSON', () => {
    // **This test asserted the defect.** It required the key to equal
    // `JSON.stringify([{ a: 1 }])`, which is the wholesale fallback CACHE-009
    // removed — the fallback that mapped `undefined`, functions and every
    // `Map`/`Set`/`RegExp` onto the same text, so distinct calls shared a cache
    // entry. Pinned as a description of intended behaviour, in a file whose name
    // has nothing to do with the code under test.
    //
    // It now asserts the property that matters: structurally equal arguments
    // share a key, and structurally different ones do not.
    expect(simpleArgsKey({ a: 1 })).toBe(simpleArgsKey({ a: 1 }));
    expect(simpleArgsKey({ a: 1 })).not.toBe(simpleArgsKey({ a: 2 }));
    // And it is no longer the JSON text, which was the whole problem.
    expect(simpleArgsKey({ a: 1 })).not.toBe(JSON.stringify([{ a: 1 }]));
  });

  it('handles bigint arguments instead of throwing', () => {
    // `JSON.stringify` throws on BigInt, so the previous "fast scalar path"
    // blew up on an entirely ordinary argument type (64-bit ids, etc.).
    expect(simpleArgsKey(10n)).toBe('g:10');
    expect(simpleArgsKey(1n, 2n)).toBe('g:1|g:2');
    expect(simpleArgsKey(10n)).not.toBe(simpleArgsKey(11n));
    expect(simpleArgsKey(10n)).toBe(simpleArgsKey(10n));
  });

  it('normalises -0 to 0 so both share one cache entry', () => {
    // The normalisation it used to describe was `String(v === 0 ? 0 : v)`, and
    // `String(-0)` is *already* `'0'` — so that expression could not change the
    // result, and this test passed whichever way it was written. A mutation
    // check deleting it reported NOT CAUGHT, which is how the dead code was
    // found. `String` does the normalising; the guard belongs here because the
    // behaviour is worth pinning, not because the source needs help.
    expect(simpleArgsKey(-0)).toBe(simpleArgsKey(0));
    expect(simpleArgsKey(-0)).toBe('d:0');
  });

  it('throws on symbol arguments rather than aliasing them all to one key', () => {
    // `JSON.stringify` maps every Symbol to `null`, so every symbol argument
    // used to produce the same key `'[null]'` - silent cache poisoning.
    expect(() => simpleArgsKey(Symbol.for('x'))).toThrow(TypeError);
    expect(() => simpleArgsKey('a', Symbol('y'))).toThrow(/symbol/);
  });
});
