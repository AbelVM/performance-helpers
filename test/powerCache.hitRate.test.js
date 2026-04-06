import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

describe('PowerCache hitRate', () => {
  it('reports correct hit rate', () => {
    const c = new PowerCache();
    // one hit
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
    // one miss
    expect(c.get('missing')).toBeUndefined();
    // hit rate should be 0.5
    expect(c.hits).toBe(1);
    expect(c.misses).toBe(1);
    expect(c.hitRate).toBeCloseTo(0.5);
  });

  it('returns 0 when no samples yet', () => {
    const c = new PowerCache();
    expect(c.hits).toBe(0);
    expect(c.misses).toBe(0);
    expect(c.hitRate).toBe(0);
  });

  it('is iterable via Symbol.iterator in MRU order', () => {
    const c = new PowerCache();
    c.set('a', 1);
    c.set('b', 2);
    const iterated = Array.from(c);
    expect(iterated).toEqual([
      ['b', 2],
      ['a', 1],
    ]);
  });
});
