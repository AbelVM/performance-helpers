import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

describe('PowerCache.touch()', () => {
  it('updates recency without changing value', () => {
    const c = new PowerCache();
    c.set('a', 1);
    c.set('b', 2);
    // MRU order should be b, a
    const before = Array.from(c.entries('MRU')).map(([k]) => k);
    expect(before).toEqual(['b', 'a']);

    const ok = c.touch('a');
    expect(ok).toBe(true);
    const after = Array.from(c.entries('MRU')).map(([k]) => k);
    expect(after).toEqual(['a', 'b']);
    // value unchanged
    expect(c.get('a')).toBe(1);
  });

  it('returns false and removes expired entries', async () => {
    const c = new PowerCache();
    // set with very short TTL
    c.set('x', 42, { ttl: 5 });
    await delay(20);
    // now expired
    const ok = c.touch('x');
    expect(ok).toBe(false);
    expect(c.get('x')).toBeUndefined();
  });

  it('refreshes TTL when provided', async () => {
    const c = new PowerCache();
    c.set('k', 'v', { ttl: 10 });
    // touch with longer ttl
    const ok = c.touch('k', 1000);
    expect(ok).toBe(true);
    // wait for original TTL to have passed but before refreshed TTL
    await delay(50);
    expect(c.get('k')).toBe('v');
  });
});
