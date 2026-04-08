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

  it('falls back to JSON for non-scalar arguments', () => {
    expect(simpleArgsKey({ a: 1 })).toBe(JSON.stringify([{ a: 1 }]));
    expect(simpleArgsKey(Symbol.for('x'))).toBe(JSON.stringify([Symbol.for('x')]));
  });
});
