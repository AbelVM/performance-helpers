import { describe, it, expect } from 'vitest';
import { PowerTimedCache } from '../src/helpers/powerCache.js';

describe('PowerTimedCache convenience wrapper', () => {
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
});
