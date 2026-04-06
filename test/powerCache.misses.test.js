import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

describe('PowerCache misses accounting', () => {
  it('counts a miss when get() finds an expired entry, but passive cleanup does not increment misses', async () => {
    const c = new PowerCache({ defaultTTL: 1, maxCleanupPerTick: 10 });

    // insert an entry with short TTL
    c.set('a', 1, { ttl: 1 });
    // allow it to expire
    await new Promise((r) => setTimeout(r, 5));

    // At this point the background cleanup has not run; explicit passive cleanup will remove
    // entries but should not count as a user-facing miss.
    const beforeMisses = c.misses;

    // passive cleanup (simulates cleanup timer)
    c.cleanupExpiredUpTo(1000);
    expect(c.misses).toBe(beforeMisses);

    // inserting the key again and letting it expire, then calling get() should count a miss
    c.set('b', 2, { ttl: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const before = c.misses;
    const val = c.get('b');
    expect(val).toBeUndefined();
    expect(c.misses).toBe(before + 1);
  });

  it('counts a miss when getOrSetAsync sees expired entries and recomputes', async () => {
    const c = new PowerCache({ defaultTTL: 1 });
    c.set('k', 1, { ttl: 1 });
    await new Promise((r) => setTimeout(r, 5));

    const before = c.misses;
    const result = await c.getOrSetAsync('k', async () => 2);
    expect(result).toBe(2);
    expect(c.misses).toBe(before + 1);
  });

  it('counts misses for expired entries in getMany when ignoreExpiry is false', async () => {
    const c = new PowerCache({ defaultTTL: 1 });
    c.set('a', 1, { ttl: 1 });
    c.set('b', 2, { ttl: 1 });
    await new Promise((r) => setTimeout(r, 5));

    const before = c.misses;
    const found = c.getMany(['a', 'b'], { ignoreExpiry: false });
    expect(found.size).toBe(0);
    expect(c.misses).toBe(before + 2);
  });
});
