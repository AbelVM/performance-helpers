import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  PowerThrottle,
  PowerSlidingWindow,
  PowerBatch,
  PowerQueue,
  PowerGCRA,
  PowerCache,
  PowerCircuit,
  PowerPermitGate,
  PowerDeadline,
  PowerPool,
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

  it('rejects a nonsensical refillRate', () => {
    // **The `refillInterval` half of this test was removed with the option.**
    // It asserted that `refillInterval: 0` throws, so the option was pinned as
    // validated-and-live — which is exactly the thing it was not: it was
    // destructured, validated, typed, published, and then never read. `AGENTS.md`
    // is explicit that a documented deliberate decision needs its documentation
    // and its pinning test changed together, and the pin was wrong rather than
    // the behaviour, so it goes with the option.
    //
    // `refillInterval` is not rejected now, it is *ignored*: the throttle's
    // bucket refills lazily and proportionally to elapsed time, so there is no
    // interval to validate. See `test/deadOptions.family.test.js` for the
    // arithmetic that replaces it.
    expect(() => new PowerThrottle({ refillRate: Number.NaN })).toThrow(/refillRate/);
    expect(() => new PowerThrottle({ refillRate: -1 })).toThrow(/refillRate/);
  });

  it('rejects a refillInterval left over from a caller that still passes it', () => {
    // Previously "ignores a refillInterval left over from a caller that still
    // passes it". That tolerance is sound for a removed option and silent for a
    // misspelled one, and it is the same tolerance that let this repository's own
    // tests pass nine nonexistent options and let `guides/powerThrottle.md`
    // document `refillInterval` as live while the generated types omitted it.
    expect(() => new PowerThrottle({ capacity: 5, refillRate: 2, refillInterval: 0 })).toThrow(
      /^PowerThrottle: unknown option `refillInterval`\./
    );
  });

  it('still accepts refillRate: 0, which is a legitimate "no refill"', () => {
    const t = new PowerThrottle({ capacity: 5, refillRate: 0 });
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
    const w = new PowerSlidingWindow({ capacity: 3, windowMs: 1000 });
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
          expect(() => new PowerThrottle({ capacity, refillRate: rate / 1000 })).not.toThrow();
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

// ─── QUAL-001, part 2: the limiters and the deadline runner ──────────────────
//
// Each of these had a hand-rolled coercion that read `0` as "absent" and
// substituted a plausible default. For a permit gate and a circuit breaker that
// is the worst direction to fail in: the configuration asked for was "allow
// nothing" or "never trip", and the object built was the opposite.
describe('PowerCircuit option validation (QUAL-001)', () => {
  it('rejects threshold 0 rather than reading it as absent', () => {
    // `Number(0) || 5` gave a breaker that never trips. The failure was silent
    // and the symptom appears only under load.
    expect(() => new PowerCircuit({ threshold: 0 })).toThrow(TypeError);
    expect(() => new PowerCircuit({ threshold: 0 })).toThrow(/threshold/);
  });

  it('rejects a negative or non-numeric threshold', () => {
    expect(() => new PowerCircuit({ threshold: -1 })).toThrow(TypeError);
    expect(() => new PowerCircuit({ threshold: 'many' })).toThrow(TypeError);
    expect(() => new PowerCircuit({ threshold: Number.NaN })).toThrow(TypeError);
  });

  it('still accepts every valid threshold and falls back when omitted', () => {
    for (const n of [1, 2, 5, 100]) {
      expect(new PowerCircuit({ threshold: n })._threshold).toBe(n);
    }
    expect(new PowerCircuit()._threshold).toBe(5);
    expect(new PowerCircuit({})._threshold).toBe(5);
  });

  it('rejects timeout 0, which used to become 30s', () => {
    expect(() => new PowerCircuit({ timeout: 0 })).toThrow(TypeError);
    expect(() => new PowerCircuit({ timeout: -1 })).toThrow(TypeError);
  });

  it('derives maxTimeout only when it is absent, and validates it otherwise', () => {
    expect(new PowerCircuit({ timeout: 100 })._maxTimeout).toBe(100 * 16);
    expect(new PowerCircuit({ timeout: 100, maxTimeout: 5000 })._maxTimeout).toBe(5000);
    // An explicit `maxTimeout: 0` is a real mistake, not a request for the
    // default - it would make the open window vanish.
    expect(() => new PowerCircuit({ timeout: 100, maxTimeout: 0 })).toThrow(TypeError);
  });
});

describe('PowerPermitGate option validation (QUAL-001)', () => {
  it('rejects capacity 0 rather than reading it as absent', () => {
    // `Math.max(1, Math.floor(Number(0) || 1))` gave a gate holding ONE permit.
    // A gate configured to allow nothing is how a dependency is switched off,
    // and silently becoming open is the worst possible direction to fail.
    expect(() => new PowerPermitGate({ capacity: 0 })).toThrow(TypeError);
    expect(() => new PowerPermitGate({ capacity: 0 })).toThrow(/capacity/);
  });

  it('rejects a negative or non-numeric capacity', () => {
    expect(() => new PowerPermitGate({ capacity: -3 })).toThrow(TypeError);
    expect(() => new PowerPermitGate({ capacity: 'lots' })).toThrow(TypeError);
  });

  it('still accepts every valid capacity and defaults to 1', () => {
    for (const n of [1, 2, 8, 1024]) {
      expect(new PowerPermitGate({ capacity: n })._capacity).toBe(n);
    }
    expect(new PowerPermitGate()._capacity).toBe(1);
  });

  it('accepts queueCapacity 0 and Infinity, and rejects nonsense', () => {
    expect(new PowerPermitGate({ queueCapacity: 0 })._queueCapacity).toBe(0);
    expect(new PowerPermitGate({ queueCapacity: Infinity })._queueCapacity).toBe(Infinity);
    expect(new PowerPermitGate()._queueCapacity).toBe(Infinity);
    expect(() => new PowerPermitGate({ queueCapacity: -1 })).toThrow(TypeError);
  });

  it('accepts initialTokens 0, because "start empty" is a real request', () => {
    const g = new PowerPermitGate({ capacity: 4, initialTokens: 0 });
    expect(g._available).toBe(0);
    // tryAcquire() grants immediately by returning true; with no tokens it
    // returns a waiter to be called on release, so the check is that it is not
    // an immediate grant.
    expect(g.tryAcquire()).not.toBe(true);
  });

  it('clamps initialTokens to capacity rather than rejecting it', () => {
    expect(new PowerPermitGate({ capacity: 4, initialTokens: 99 })._available).toBe(4);
    expect(() => new PowerPermitGate({ capacity: 4, initialTokens: -1 })).toThrow(TypeError);
  });
});

describe('PowerDeadline option validation (QUAL-001)', () => {
  it('rejects maxAttempts 0 and negatives, which used to become 1', async () => {
    // A caller who computed a retry budget and silently got 1 attempt back
    // would never find out.
    await expect(PowerDeadline.run(() => 1, { maxAttempts: 0 })).rejects.toThrow(TypeError);
    await expect(PowerDeadline.run(() => 1, { maxAttempts: -5 })).rejects.toThrow(TypeError);
  });

  it('rejects a non-numeric retryDelay, which used to become 0', async () => {
    await expect(PowerDeadline.run(() => 1, { retryDelay: 'soon' })).rejects.toThrow(TypeError);
  });

  it('accepts retryDelay 0, which is a real request', async () => {
    await expect(PowerDeadline.run(() => 1, { retryDelay: 0 })).resolves.toBe(1);
  });

  it('accepts valid budgets and still defaults sensibly', async () => {
    await expect(PowerDeadline.run(() => 1, { maxAttempts: 3 })).resolves.toBe(1);
    await expect(PowerDeadline.run(() => 1, {})).resolves.toBe(1);
    await expect(PowerDeadline.run(() => 1, { totalTimeout: 1000 })).resolves.toBe(1);
    await expect(PowerDeadline.run(() => 1, { attemptTimeout: 50 })).resolves.toBe(1);
  });
});

// ─── QUAL-001, part 3: the pool's size family ───────────────────────────────
//
// The hazard here is NaN rather than a wrong-but-plausible default.
// `Math.max(0, value)` is silent when `value` is not a number: the result is
// NaN, and **every comparison against NaN is false**. A pool constructed with a
// non-numeric `minSize` therefore does not complain — its reaper's idle
// comparison can never be true, so it silently never terminates a worker.
describe('PowerPool size option validation (QUAL-001)', () => {
  class NullWorker {
    constructor() {
      this.onmessage = null;
      this.postMessage = () => {};
      this.terminate = () => {};
    }
  }

  it('rejects a non-numeric minSize rather than yielding NaN', () => {
    expect(() => new PowerPool(NullWorker, { minSize: 'lots' })).toThrow(TypeError);
    expect(() => new PowerPool(NullWorker, { minSize: 'lots' })).toThrow(/minSize/);
    // The old `Math.max(0, x)` produced NaN here, and every comparison against
    // NaN is false - so the reaper silently never fired.
    expect(() => new PowerPool(NullWorker, { minSize: Number.NaN })).toThrow(TypeError);
  });

  it('rejects a negative minSize or maxSize', () => {
    expect(() => new PowerPool(NullWorker, { minSize: -1 })).toThrow(TypeError);
    expect(() => new PowerPool(NullWorker, { maxSize: -4 })).toThrow(TypeError);
  });

  it('keeps 0 legal for every size option, because scale-from-zero is real', () => {
    // Clamping these to 1 would take away "start with nothing and grow on
    // demand", which is a legitimate and useful configuration.
    const pool = new PowerPool(NullWorker, { size: 0, minSize: 0, maxSize: 0 });
    expect(pool.minSize).toBe(0);
    expect(pool.maxSize).toBe(0);
    pool.terminate();
  });

  it('still raises maxSize to at least minSize', () => {
    const pool = new PowerPool(NullWorker, { minSize: 3, maxSize: 1 });
    expect(pool.maxSize).toBe(3);
    pool.terminate();
  });

  it('rejects a non-numeric idleTimeout', () => {
    expect(() => new PowerPool(NullWorker, { idleTimeout: 'soon' })).toThrow(TypeError);
    expect(() => new PowerPool(NullWorker, { idleTimeout: Number.NaN })).toThrow(TypeError);
  });

  it('keeps idleTimeout 0 and Infinity legal, both of which are meaningful', () => {
    // 0 reaps aggressively; Infinity disables the idle reaper entirely.
    const aggressive = new PowerPool(NullWorker, { idleTimeout: 0 });
    expect(aggressive.idleTimeout).toBe(0);
    aggressive.terminate();
    const never = new PowerPool(NullWorker, { idleTimeout: Infinity });
    expect(never.idleTimeout).toBe(Infinity);
    never.terminate();
  });

  it('leaves maxTasksPerWorker unvalidated, because 0 is part of its contract', () => {
    // Unlike the size options, `maxTasksPerWorker: 0` is finite - it never
    // produces the NaN this guards against - and it means "every worker is
    // immediately full", which existing tests rely on to force the queue path.
    // Constraining it would change documented behaviour for tidiness.
    const pool = new PowerPool(NullWorker, { maxTasksPerWorker: 0 });
    expect(pool._maxTasksPerWorker).toBe(0);
    pool.terminate();
  });
});
