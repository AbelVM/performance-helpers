import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/helpers/cache/core.js';

describe('PowerCache.load (snapshot prefill, M-05)', () => {
  it('returns 0 for null/undefined/empty', () => {
    const c = new PowerCache({ maxEntries: 10 });
    expect(c.load(null)).toBe(0);
    expect(c.load(undefined)).toBe(0);
    expect(c.load([])).toBe(0);
  });

  it('accepts [key, value] arrays', () => {
    const c = new PowerCache({ maxEntries: 10 });
    const n = c.load([
      ['a', 1],
      ['b', 2],
    ]);
    expect(n).toBe(2);
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBe(2);
  });

  it('accepts [key, value, {ttl, weight}] arrays', () => {
    const c = new PowerCache({ maxEntries: 10, defaultTTL: 1000 });
    const n = c.load([['a', 1, { ttl: 50, weight: 2 }]]);
    expect(n).toBe(1);
    expect(c.get('a')).toBe(1);
  });

  it('accepts { key, value, ttl, weight } objects', () => {
    const c = new PowerCache({ maxEntries: 10 });
    const n = c.load([{ key: 'x', value: 42, ttl: 1000, weight: 1 }]);
    expect(n).toBe(1);
    expect(c.get('x')).toBe(42);
  });

  it('accepts Map entries', () => {
    const c = new PowerCache({ maxEntries: 10 });
    const m = new Map([['k', 'v']]);
    const n = c.load(m);
    expect(n).toBe(1);
    expect(c.get('k')).toBe('v');
  });

  it('skips unknown shapes', () => {
    const c = new PowerCache({ maxEntries: 10 });
    const n = c.load([42, 'str', { foo: 1 }, null]);
    expect(n).toBe(0);
  });

  it('respects rejectOversized', () => {
    const c = new PowerCache({ maxEntries: 10, maxWeight: 1, rejectOversized: true });
    const n = c.load([['big', 'x'.repeat(100), { weight: 100 }]]);
    expect(n).toBe(0);
    expect(c.get('big')).toBeUndefined();
  });

  it('applies admission policy (TinyLFU) and counts accepted', () => {
    const c = new PowerCache({ maxEntries: 2, policy: 'tinylfu' });
    const n = c.load([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    expect(n).toBeLessThanOrEqual(3);
    expect(c.size).toBeLessThanOrEqual(2);
  });
});
