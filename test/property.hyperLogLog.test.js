import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { HyperLogLog } from '../src/utils/hyperLogLog.js';

const RUNS = Number(process.env.FAST_CHECK_NUM_RUNS || 200);

describe('HyperLogLog property invariants', () => {
  it('is idempotent: re-adding the same value does not change the estimate', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 200 }), (vals) => {
        const once = new HyperLogLog();
        const twice = new HyperLogLog();
        for (const v of vals) once.addHash(v);
        for (const v of vals) {
          twice.addHash(v);
          twice.addHash(v);
        }
        expect(twice.cardinality()).toBe(once.cardinality());
      }),
      { numRuns: RUNS }
    );
  });

  it('is monotonic: adding elements never decreases the estimate', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 200 }), (vals) => {
        const h = new HyperLogLog();
        let prev = 0;
        for (const v of vals) {
          h.addHash(v);
          const cur = h.cardinality();
          expect(cur).toBeGreaterThanOrEqual(prev);
          prev = cur;
        }
      }),
      { numRuns: RUNS }
    );
  });

  it('reset() returns to an empty sketch', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 200 }), (vals) => {
        const h = new HyperLogLog();
        for (const v of vals) h.addHash(v);
        h.reset();
        expect(h.cardinality()).toBe(0);
        expect(h.isDense).toBe(false);
      }),
      { numRuns: RUNS }
    );
  });

  it('sparse phase counts distinct values exactly for small cardinalities', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 20 }), (vals) => {
        const h = new HyperLogLog(64, { sparse: true, sparseThreshold: 1000 });
        for (const v of vals) h.addHash(v);
        const distinct = new Set(vals).size;
        // Sparse phase should be exact (or converted to dense only if threshold exceeded).
        if (!h.isDense) {
          expect(h.cardinality()).toBe(distinct);
        } else {
          expect(h.cardinality()).toBeGreaterThan(0);
        }
      }),
      { numRuns: RUNS }
    );
  });

  it('disabling sparse still produces a sane estimate', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 200 }), (vals) => {
        const h = new HyperLogLog(64, { sparse: false });
        for (const v of vals) h.addHash(v);
        const distinct = new Set(vals).size;
        // Dense HLL is approximate; just sanity-bound it.
        if (distinct === 0) {
          expect(h.cardinality()).toBe(0);
        } else {
          expect(h.cardinality()).toBeGreaterThan(0);
        }
      }),
      { numRuns: RUNS }
    );
  });
});
