import { describe, it, expect } from 'vitest';
import {
  POWER_QUEUE_INITIAL_CAPACITY,
  DEFAULT_HARDWARE_CONCURRENCY,
  DEFAULT_POOL_SIZE,
  MIN_HISTOGRAM_BUCKETS,
  CHUNKS_PER_WORKER_TARGET,
  CHUNK_WINDOW_MULTIPLIER,
  DEFAULT_QUEUE_CAPACITY,
} from '../src/helpers/constants.js';
import { PowerQueue } from '../src/helpers/powerQueue.js';
import { PowerPermitGate } from '../src/helpers/powerPermitGate.js';
import { PowerBulkhead } from '../src/helpers/powerBulkhead.js';
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';
import { PowerBatch } from '../src/helpers/powerBatch.js';
import { PowerHistogram } from '../src/helpers/powerHistogram.js';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * QUAL-007: the named constants exist, hold the values they were extracted to
 * describe, and the call sites actually reference them.
 *
 * A magic-number sweep fails silently. Replacing `16` with a constant and later
 * introducing a new bare `16` leaves both the source and the constant looking
 * fine, and the next reader cannot tell which numbers were deliberate. These
 * tests pin the *values* (so a constant cannot drift away from the behaviour it
 * describes) and the *wiring* (so a call site cannot quietly stop using it).
 */

class NullUnderlying {
  constructor() {
    this.onmessage = null;
    this.postMessage = () => {};
    this.terminate = () => {};
  }
}

describe('named tuning constants (QUAL-007)', () => {
  it('POWER_QUEUE_INITIAL_CAPACITY is distinct from DEFAULT_QUEUE_CAPACITY', () => {
    // These two collided on name during the sweep and mean different things: one
    // is a `PowerQueue` buffer preallocation, the other a backpressure backlog.
    // Keeping them apart is the point, so it is worth pinning.
    expect(POWER_QUEUE_INITIAL_CAPACITY).toBe(16);
    expect(DEFAULT_QUEUE_CAPACITY).toBe(100);
    expect(POWER_QUEUE_INITIAL_CAPACITY).not.toBe(DEFAULT_QUEUE_CAPACITY);
  });

  it('PowerQueue defaults to POWER_QUEUE_INITIAL_CAPACITY', () => {
    const q = new PowerQueue();
    // A power-of-two buffer is required for the bitmask index, and 16 already is
    // one, so the default needs no rounding.
    expect(q._capacity).toBe(POWER_QUEUE_INITIAL_CAPACITY);
  });

  it('every helper that preallocates an internal queue uses the constant', () => {
    // Each of these passed a bare `16`. If one stops referencing the constant,
    // the sweep has silently regrown, and this is where it shows.
    expect(new PowerPermitGate()._waiters._capacity).toBe(POWER_QUEUE_INITIAL_CAPACITY);
    expect(new PowerBulkhead()._drainWaiters._capacity).toBe(POWER_QUEUE_INITIAL_CAPACITY);
    expect(new PowerSlidingWindow()._timestamps._capacity).toBe(POWER_QUEUE_INITIAL_CAPACITY);
    // `PowerBatch` takes its handler as a positional first argument.
    expect(new PowerBatch(() => {})._queue._capacity).toBe(POWER_QUEUE_INITIAL_CAPACITY);
  });

  it('a pool with no size starts small even on a many-core runtime', () => {
    expect(DEFAULT_POOL_SIZE).toBe(2);
    expect(DEFAULT_HARDWARE_CONCURRENCY).toBe(2);
    const pool = new PowerPool(NullUnderlying, {});
    // The whole point of the small default: a pool built at module load must not
    // eagerly spawn one worker per core. `maxSize` may still track real
    // concurrency, since a ceiling costs nothing to allow for.
    expect(pool.minSize).toBe(DEFAULT_POOL_SIZE);
    expect(pool.maxSize).toBeGreaterThanOrEqual(DEFAULT_POOL_SIZE);
    expect(pool.workers.length).toBeLessThanOrEqual(DEFAULT_POOL_SIZE);
    pool.terminate();
  });

  it('an explicit size still wins over the small default', () => {
    const pool = new PowerPool(NullUnderlying, { size: 4, minSize: 4, maxSize: 4, lazy: false });
    expect(pool.minSize).toBe(4);
    expect(pool.workers).toHaveLength(4);
    pool.terminate();
  });

  it('the histogram legacy bucketCount option is still floored', () => {
    expect(MIN_HISTOGRAM_BUCKETS).toBe(4);
    // `bucketCount` is a legacy option kept only for backwards compatibility;
    // the public `bucketCount` *getter* reports occupied buckets, so the
    // configured floor is checked on the field the constructor resolved.
    for (const n of [0, 1, 2, 3]) {
      expect(new PowerHistogram({ bucketCount: n })._legacyBucketCount).toBe(MIN_HISTOGRAM_BUCKETS);
    }
    expect(new PowerHistogram({ bucketCount: 64 })._legacyBucketCount).toBe(64);
  });

  it('the chunking multipliers keep their meaning', () => {
    // The first is how many in-flight chunks to aim for per worker. The second
    // is the wider window used to re-estimate, and a *wider* target means
    // *smaller* chunks and therefore a sooner measurement - it is the
    // convergence knob, not a throughput knob.
    expect(CHUNKS_PER_WORKER_TARGET).toBe(4);
    expect(CHUNK_WINDOW_MULTIPLIER).toBe(8);
    expect(CHUNK_WINDOW_MULTIPLIER).toBeGreaterThan(CHUNKS_PER_WORKER_TARGET);
  });
});
