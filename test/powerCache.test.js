import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

describe('PowerCache', () => {
  it('set/get and eviction by maxEntries', () => {
    const c = new PowerCache({ maxEntries: 2, defaultTTL: 10000 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    expect(c.size).toBeLessThanOrEqual(2);
    expect(c.get('a') === undefined || c.get('b') === undefined || c.get('c') === undefined).toBe(
      true
    );
  });

  it('rejects oversized when enabled', () => {
    const c = new PowerCache({ maxWeight: 5, weightFn: () => 10, rejectOversized: true });
    const res = c.set('x', { big: true });
    expect(res).toBe(false);
    expect(c.rejected).toBeGreaterThanOrEqual(1);
  });

  it('get handles expiry and onExpire callback', () => {
    const called = [];
    const c = new PowerCache({ defaultTTL: 1, onExpire: (k) => called.push(k) });
    c.set('k', 'v', { ttl: 1 });
    // wait to expire
    return new Promise((resolve) =>
      setTimeout(() => {
        const val = c.get('k');
        expect(val).toBeUndefined();
        expect(called).toContain('k');
        resolve();
      }, 5)
    );
  });
});
