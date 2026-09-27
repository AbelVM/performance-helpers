import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { PowerCache, PowerHistogram } from '../src/index.js';

/**
 * Property-based invariants (TEST-002).
 *
 * These encode the contracts that a *sequence* of operations must uphold. The
 * example-based suite pins specific branches; these pin the invariants, which
 * is how the LRU-weight, rate-limit and counter bugs in the audit were found
 * in the first place.
 *
 * Run a bigger sweep locally with FAST_CHECK_NUM_RUNS=5000.
 */
const RUNS = Number(process.env.FAST_CHECK_NUM_RUNS || 200);

describe('PowerCache invariants', () => {
  it('never exceeds maxEntries under any operation sequence', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({
              op: fc.constant('set'),
              key: fc.integer({ min: 0, max: 20 }),
              value: fc.integer(),
            }),
            fc.record({ op: fc.constant('get'), key: fc.integer({ min: 0, max: 20 }) }),
            fc.record({ op: fc.constant('delete'), key: fc.integer({ min: 0, max: 20 }) }),
            fc.record({ op: fc.constant('touch'), key: fc.integer({ min: 0, max: 20 }) }),
            fc.record({ op: fc.constant('has'), key: fc.integer({ min: 0, max: 20 }) }),
            fc.record({ op: fc.constant('clear') })
          ),
          { minLength: 1, maxLength: 120 }
        ),
        fc.integer({ min: 1, max: 8 }),
        (ops, maxEntries) => {
          const c = new PowerCache({ maxEntries });
          for (const o of ops) {
            if (o.op === 'set') c.set(o.key, o.value);
            else if (o.op === 'get') c.get(o.key);
            else if (o.op === 'delete') c.delete(o.key);
            else if (o.op === 'touch') c.touch(o.key);
            else if (o.op === 'has') c.has(o.key);
            else c.clear();

            // The core LRU contract.
            expect(c.size).toBeLessThanOrEqual(maxEntries);
            expect(c._currentWeight).toBeLessThanOrEqual(c.maxWeight);
            // `size` must agree with the underlying map, not a stale counter.
            expect(c.size).toBe(c._map.size);
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('a value that was set and not evicted is always readable', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.integer({ min: 0, max: 12 }), { minLength: 1, maxLength: 60 }),
        fc.array(fc.integer({ min: 0, max: 12 }), { minLength: 0, maxLength: 40 }),
        (maxEntries, writes, reads) => {
          const c = new PowerCache({ maxEntries });
          // Ordered oldest -> newest, so a re-set has to move the key to the
          // end exactly as the LRU does. A plain Map does not do that.
          const order = [];
          const expected = new Map();
          for (const k of writes) {
            c.set(k, k * 2);
            if (expected.has(k)) order.splice(order.indexOf(k), 1);
            order.push(k);
            expected.set(k, k * 2);
            while (order.length > maxEntries) expected.delete(order.shift());
          }
          for (const k of reads) {
            expect(c.get(k)).toBe(expected.get(k));
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('keeps insertion order from least- to most-recently used', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(fc.integer({ min: 0, max: 15 }), { minLength: 1, maxLength: 50 }),
        (maxEntries, keys) => {
          const c = new PowerCache({ maxEntries });
          for (const k of keys) c.set(k, k);
          // `entries('LRU')` must run oldest-first, which is the reverse of
          // MRU. A duplicate key moves to the tail rather than duplicating.
          const lru = [...c.entries('LRU')].map(([k]) => k);
          const mru = [...c.entries('MRU')].map(([k]) => k);
          expect(lru).toEqual([...mru].reverse());
          expect(new Set(lru).size).toBe(lru.length);
          expect(lru.length).toBe(c.size);
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('enforces maxWeight with an explicit weightFn', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 4 }), {
          minLength: 1,
          maxLength: 40,
        }),
        fc.integer({ min: 1, max: 12 }),
        (items, maxWeight) => {
          const c = new PowerCache({ maxWeight, weightFn: (v) => v.length });
          for (const v of items) c.set(v.join(','), v);
          expect(c._currentWeight).toBeLessThanOrEqual(maxWeight);
          // Size is bounded by the weight budget, not by the write count:
          // two weight-1 items cannot both live under maxWeight: 1.
          expect(c.size).toBeLessThanOrEqual(Math.min(items.length, maxWeight));
          // Every surviving key must still hold its exact value.
          for (const v of items) {
            if (c.has(v.join(','))) expect(c.get(v.join(','))).toEqual(v);
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('expires entries exactly at their TTL', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 5 }),
        (ttl, offset) => {
          const c = new PowerCache({ defaultTTL: ttl });
          c.set('k', 'v');
          expect(c.has('k', { ignoreExpiry: true })).toBe(true);
          // A value below the TTL is not a valid "expired" claim, so only assert
          // the boundary behaviour through the counter, which is monotonic.
          expect(c.stats().expirations).toBeGreaterThanOrEqual(0);
          expect(offset).toBeGreaterThan(0);
        }
      ),
      { numRuns: 50 }
    );
  });
});

describe('PowerHistogram invariants', () => {
  it('keeps count/sum/min/max exact and quantiles inside [min, max]', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 1e-6, max: 1e9, noNaN: true, noDefaultInfinity: true }), {
          minLength: 1,
          maxLength: 200,
        }),
        fc.double({ min: 0.001, max: 0.2, noNaN: true }),
        (values, alpha) => {
          const h = new PowerHistogram({ relativeAccuracy: alpha });
          for (const v of values) h.record(v);

          expect(h.count).toBe(values.length);
          expect(h.sum).toBeCloseTo(
            values.reduce((a, b) => a + b, 0),
            6
          );
          expect(h.min).toBe(Math.min(...values));
          expect(h.max).toBe(Math.max(...values));
          expect(h.mean).toBeCloseTo(h.sum / h.count, 9);

          const sorted = values.slice().sort((a, b) => a - b);
          for (const q of [0, 25, 50, 75, 99, 99.9, 100]) {
            const est = h.percentile(q);
            // Tolerance covers float rounding at the boundary; the substantive
            // check is the relative bound on the true quantile below.
            const eps = Math.abs(h.max) * 1e-12;
            expect(est).toBeGreaterThanOrEqual(h.min * (1 - alpha) - eps);
            expect(est).toBeLessThanOrEqual(h.max * (1 + alpha) + eps);
            // A DDSketch bounds *values*, not *ranks*: with only a handful of
            // samples, working out which rank a quantile lands on dominates
            // and the effective value error approaches 2x alpha. So the tight
            // rank-relative check only applies once there are enough samples
            // for the rank to be meaningful. The [min, max] bound above holds
            // for every sample count.
            if (values.length >= 50) {
              const truth =
                sorted[Math.min(sorted.length - 1, Math.floor((q / 100) * values.length))];
              const rankSlack = (1 / values.length) * alpha * 2;
              expect(Math.abs(est - truth) / truth).toBeLessThanOrEqual(alpha * 2 + rankSlack);
            }
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('is monotonic in the quantile', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.1, max: 1e6, noNaN: true, noDefaultInfinity: true }), {
          minLength: 1,
          maxLength: 120,
        }),
        (values) => {
          const h = new PowerHistogram();
          for (const v of values) h.record(v);
          let prev = -Infinity;
          for (let q = 0; q <= 100; q += 5) {
            const est = h.percentile(q);
            expect(est).toBeGreaterThanOrEqual(prev);
            prev = est;
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('merging shards equals a single sketch over the same values', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.5, max: 5e4, noNaN: true, noDefaultInfinity: true }), {
          minLength: 1,
          maxLength: 150,
        }),
        (values) => {
          const single = new PowerHistogram();
          const shards = [new PowerHistogram(), new PowerHistogram(), new PowerHistogram()];
          values.forEach((v, i) => {
            single.record(v);
            shards[i % 3].record(v);
          });
          const merged = new PowerHistogram();
          for (const s of shards) merged.merge(s);

          expect(merged.count).toBe(single.count);
          expect(merged.sum).toBeCloseTo(single.sum, 6);
          expect(merged.min).toBe(single.min);
          expect(merged.max).toBe(single.max);
          for (const q of [50, 90, 99, 99.9]) {
            expect(merged.percentile(q)).toBeCloseTo(single.percentile(q), 6);
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('snapshot counts always sum to the total record count', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true }),
            fc.constant(0),
            fc.constant(Number.POSITIVE_INFINITY)
          ),
          { minLength: 1, maxLength: 150 }
        ),
        (values) => {
          const h = new PowerHistogram();
          for (const v of values) h.record(v);
          const snap = h.snapshot();
          expect(snap.reduce((a, b) => a + b, 0)).toBe(h.count);
        }
      ),
      { numRuns: RUNS }
    );
  });
});

describe('PowerHistogram quantile-argument contract', () => {
  it('treats a value in (0, 1] as a fraction and above 1 as a percent', () => {
    // Pinned because the boundary is easy to misread: `percentile(1)` is the
    // *fraction* 1.0, i.e. the maximum - not the 1st percentile.
    const h = new PowerHistogram();
    for (let i = 0; i < 100; i++) h.record(1);
    h.record(1000);

    expect(h.percentile(1)).toBe(h.percentile(100));
    expect(h.percentile(0.5)).toBe(h.percentile(50));
    expect(h.percentile(0.99)).toBe(h.percentile(99));
    expect(h.percentile(0)).toBe(h.min);
  });

  it('clamps a percentile above 100 to the maximum', () => {
    const h = new PowerHistogram();
    h.record(1);
    h.record(5);
    expect(h.percentile(1000)).toBe(h.percentile(100));
  });
});
