import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

describe('PowerCache iteration', () => {
  it('for..of iterates [key,value] pairs MRU-first', () => {
    const c = new PowerCache();
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    // c was last-set so it should be MRU
    const keys = [];
    for (const [k] of c) {
      keys.push(k);
    }
    expect(keys[0]).toBe('c');
    expect(keys.length).toBe(c.size);
  });
});
