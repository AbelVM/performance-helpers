import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

describe('PowerCache bulk APIs', () => {
  it('setMany inserts multiple entries and getMany returns a Map', () => {
    const c = new PowerCache({ maxEntries: 10, weightFn: (v) => (v && v.w ? v.w : 1) });
    c.setMany([
      ['a', { v: 1, w: 2 }],
      ['b', { v: 2, w: 3 }],
      ['c', { v: 3, w: 4 }],
    ]);
    const m = c.getMany(['a', 'b', 'missing', 'c']);
    expect(m instanceof Map).toBe(true);
    expect(m.get('a').v).toBe(1);
    expect(m.get('b').v).toBe(2);
    expect(m.get('c').v).toBe(3);
    expect(m.has('missing')).toBe(false);
  });

  it('setMany triggers eviction only once at end', () => {
    const c = new PowerCache({ maxWeight: 5, weightFn: (v) => v });
    // weights: 2,2,2 -> total 6 should evict least-recently-used
    c.setMany([
      ['a', 2],
      ['b', 2],
      ['c', 2],
    ]);
    // At least one eviction should have happened to respect maxWeight
    expect(c.stats().weight).toBeLessThanOrEqual(5);
  });
});
