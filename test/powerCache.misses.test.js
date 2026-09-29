import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

// TEST-008. These waits were 5 ms of wall clock against a 1 ms TTL. A
// `setTimeout(0)` is a macrotask, so a 5 ms wait is really "5 ms plus however
// long the loop takes to get round to us" - a race with the scheduler that
// passes on an idle machine. The TTL here is 1 ms, which is impossible to
// exercise on real time at all without that race; a fake clock makes "expired"
// a number instead of a hope. The 5 ms is kept, so nothing about what the test
// claims to have elapsed changes.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PowerCache misses accounting', () => {
  it('counts a miss when get() finds an expired entry, but passive cleanup does not increment misses', async () => {
    const c = new PowerCache({ defaultTTL: 1, maxCleanupPerTick: 10 });

    // insert an entry with short TTL
    c.set('a', 1, { ttl: 1 });
    // allow it to expire
    await vi.advanceTimersByTimeAsync(5);

    // At this point the background cleanup has not run; explicit passive cleanup will remove
    // entries but should not count as a user-facing miss.
    const beforeMisses = c.misses;

    // passive cleanup (simulates cleanup timer)
    c.cleanupExpiredUpTo(1000);
    expect(c.misses).toBe(beforeMisses);

    // inserting the key again and letting it expire, then calling get() should count a miss
    c.set('b', 2, { ttl: 1 });
    await vi.advanceTimersByTimeAsync(5);
    const before = c.misses;
    const val = c.get('b');
    expect(val).toBeUndefined();
    expect(c.misses).toBe(before + 1);
  });

  it('counts a miss when getOrSetAsync sees expired entries and recomputes', async () => {
    const c = new PowerCache({ defaultTTL: 1 });
    c.set('k', 1, { ttl: 1 });
    await vi.advanceTimersByTimeAsync(5);

    const before = c.misses;
    const result = await c.getOrSetAsync('k', async () => 2);
    expect(result).toBe(2);
    expect(c.misses).toBe(before + 1);
  });

  it('counts misses for expired entries in getMany when ignoreExpiry is false', async () => {
    const c = new PowerCache({ defaultTTL: 1 });
    c.set('a', 1, { ttl: 1 });
    c.set('b', 2, { ttl: 1 });
    await vi.advanceTimersByTimeAsync(5);

    const before = c.misses;
    const found = c.getMany(['a', 'b'], { ignoreExpiry: false });
    expect(found.size).toBe(0);
    expect(c.misses).toBe(before + 2);
  });
});
