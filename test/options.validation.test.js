import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  PowerThrottle,
  PowerSlidingWindow,
  PowerBatch,
  PowerQueue,
  PowerGCRA,
  PowerCache,
} from '../src/index.js';

/**
 * Option validation (QUAL-001 / BUG-024).
 *
 * The library used to hand-roll `Math.max(0, Number(x) || 0)` in every
 * constructor, which silently coerced nonsense into a plausible-looking value.
 * The worst cases produced quietly broken behaviour rather than an error:
 *
 * - `PowerBatch({ maxSize: 0 })` became `Infinity`, so the batch accumulated
 *   forever and never flushed on its own.
 * - `PowerThrottle({ capacity: 0 })` became a throttle that can never succeed.
 * - `PowerCache({ maxEntries: NaN })` made `size > NaN` always false, so
 *   eviction never ran and the cache grew without bound.
 *
 * These assert that a nonsensical limit is now a loud configuration error.
 */

describe('PowerBatch maxSize', () => {
  it('rejects a non-positive or non-finite maxSize', () => {
    expect(() => new PowerBatch(() => {}, { maxSize: 0 })).toThrow(/maxSize/);
    expect(() => new PowerBatch(() => {}, { maxSize: -1 })).toThrow(/maxSize/);
    expect(() => new PowerBatch(() => {}, { maxSize: Number.NaN })).toThrow(/maxSize/);
    expect(() => new PowerBatch(() => {}, { maxSize: 'lots' })).toThrow(/maxSize/);
  });

  it('accepts Infinity as an explicit "never auto-flush"', () => {
    expect(new PowerBatch(() => {}, { maxSize: Number.POSITIVE_INFINITY })._maxSize).toBe(
      Number.POSITIVE_INFINITY
    );
    expect(new PowerBatch(() => {}, {})._maxSize).toBe(Number.POSITIVE_INFINITY);
    expect(new PowerBatch(() => {}, { maxSize: 8 })._maxSize).toBe(8);
  });

  it('flushes once maxSize is reached', async () => {
    const calls = [];
    const b = new PowerBatch((items) => calls.push(items.slice()), { maxSize: 2 });
    b.add(1);
    b.add(2);
    await Promise.resolve();
    await b.flush();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toEqual([1, 2]);
  });
});

describe('PowerThrottle options', () => {
  it('rejects a zero or nonsensical capacity instead of never succeeding', () => {
    expect(() => new PowerThrottle({ capacity: 0 })).toThrow(/capacity/);
    expect(() => new PowerThrottle({ capacity: -3 })).toThrow(/capacity/);
    expect(() => new PowerThrottle({ capacity: Number.NaN })).toThrow(/capacity/);
  });

  it('rejects a nonsensical refillRate or refillInterval', () => {
    expect(() => new PowerThrottle({ refillRate: Number.NaN })).toThrow(/refillRate/);
    expect(() => new PowerThrottle({ refillRate: -1 })).toThrow(/refillRate/);
    expect(() => new PowerThrottle({ refillInterval: 0 })).toThrow(/refillInterval/);
  });

  it('still accepts refillRate: 0, which is a legitimate "no refill"', () => {
    const t = new PowerThrottle({ limit: 5, capacity: 5, refillRate: 0 });
    expect(t.refillRate).toBe(0);
    expect(t.capacity).toBe(5);
  });

  it('defaults are unchanged', () => {
    const t = new PowerThrottle({});
    expect(t.capacity).toBe(1);
    expect(t.refillRate).toBe(0);
  });
});

describe('PowerSlidingWindow options', () => {
  it('rejects a zero capacity, which used to refuse everything', () => {
    expect(() => new PowerSlidingWindow({ capacity: 0 })).toThrow(/capacity/);
    expect(() => new PowerSlidingWindow({ capacity: Number.NaN })).toThrow(/capacity/);
  });

  it('rejects a non-positive windowMs', () => {
    expect(() => new PowerSlidingWindow({ windowMs: 0 })).toThrow(/windowMs/);
    expect(() => new PowerSlidingWindow({ windowMs: -1000 })).toThrow(/windowMs/);
  });

  it('accepts valid options and still grants up to the limit', () => {
    const w = new PowerSlidingWindow({ limit: 3, windowMs: 1000, capacity: 3 });
    expect(w.tryConsume()).toBe(true);
    expect(w.tryConsume()).toBe(true);
    expect(w.tryConsume()).toBe(true);
    expect(w.tryConsume()).toBe(false);
  });
});

describe('PowerQueue initialCapacity', () => {
  it('rejects a non-finite or negative request', () => {
    expect(() => new PowerQueue(Number.NaN)).toThrow(/initialCapacity/);
    expect(() => new PowerQueue(-1)).toThrow(/initialCapacity/);
  });

  it('rounds a small hint up rather than rejecting it', () => {
    // 0 and 1 are legitimate capacity hints: the buffer length must be a
    // power of two of at least 2 for the bitmask indexing to be correct.
    expect(new PowerQueue(0)._capacity).toBe(2);
    expect(new PowerQueue(1)._capacity).toBe(2);
    expect(new PowerQueue()._capacity).toBe(16);
  });

  it('rounds up to a power of two, which the bitmask indexing requires', () => {
    expect(new PowerQueue(16)._capacity).toBe(16);
    expect(new PowerQueue(17)._capacity).toBe(32);
    expect(new PowerQueue(3)._capacity).toBe(4);
    // The internal length is always a power of two, which the mask requires.
    for (const n of [2, 5, 9, 33, 100]) {
      const cap = new PowerQueue(n)._capacity;
      expect(cap & (cap - 1)).toBe(0);
    }
  });
});

describe('PowerGCRA options', () => {
  it('rejects a non-positive rate', () => {
    expect(() => new PowerGCRA({ rate: 0 })).toThrow(/rate/);
    expect(() => new PowerGCRA({ rate: -1 })).toThrow(/rate/);
    expect(() => new PowerGCRA({})).toThrow(/rate/);
  });

  it('rejects a non-positive per and a negative burst', () => {
    expect(() => new PowerGCRA({ rate: 1, per: 0 })).toThrow(/per/);
    expect(() => new PowerGCRA({ rate: 1, burst: -1 })).toThrow(/burst/);
  });
});

describe('PowerCache limits', () => {
  it('rejects NaN, which used to disable eviction entirely', () => {
    expect(() => new PowerCache({ maxEntries: Number.NaN })).toThrow(/maxEntries/);
    expect(() => new PowerCache({ maxEntries: -1 })).toThrow(/maxEntries/);
  });

  it('keeps Infinity as the documented unbounded default', () => {
    expect(new PowerCache().maxEntries).toBe(Number.POSITIVE_INFINITY);
    expect(new PowerCache({ maxEntries: Number.POSITIVE_INFINITY }).maxEntries).toBe(
      Number.POSITIVE_INFINITY
    );
  });
});

describe('validation never breaks a valid configuration', () => {
  it('accepts every positive integer for the numeric limits it guards', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (capacity, windowMs, rate) => {
          expect(() => new PowerSlidingWindow({ capacity, windowMs })).not.toThrow();
          expect(() => new PowerThrottle({ capacity, refillInterval: windowMs })).not.toThrow();
          expect(() => new PowerGCRA({ rate, per: windowMs })).not.toThrow();
          expect(() => new PowerQueue(capacity)).not.toThrow();
          expect(() => new PowerBatch(() => {}, { maxSize: capacity })).not.toThrow();
          expect(() => new PowerCache({ maxEntries: capacity })).not.toThrow();
        }
      ),
      { numRuns: 200 }
    );
  });

  it('rejects NaN and negatives consistently across the guarded constructors', () => {
    for (const bad of [Number.NaN, -1, 0]) {
      if (bad === 0) {
        // 0 is invalid where the floor is 1 or more. PowerQueue is the
        // exception: 0 is a legitimate hint that rounds up to 2.
        expect(() => new PowerSlidingWindow({ capacity: 0 })).toThrow();
        expect(() => new PowerThrottle({ capacity: 0 })).toThrow();
        expect(() => new PowerQueue(0)).not.toThrow();
      } else {
        expect(() => new PowerSlidingWindow({ capacity: bad })).toThrow();
        expect(() => new PowerThrottle({ capacity: bad })).toThrow();
        expect(() => new PowerQueue(bad)).toThrow();
        expect(() => new PowerCache({ maxEntries: bad })).toThrow();
        expect(() => new PowerGCRA({ rate: bad })).toThrow();
      }
    }
  });
});
