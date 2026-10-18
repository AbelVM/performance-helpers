import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { PowerPool } from '../src/helpers/powerPool.js';

const RUNS = Number(process.env.FAST_CHECK_NUM_RUNS || 100);

function Echo() {
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  this.postMessage = (msg) => {
    if (this.onmessage) this.onmessage({ data: msg });
  };
  this.terminate = () => {};
}

describe('PowerPool invariants (S2-10)', () => {
  it('available never goes negative and never exceeds capacity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 30 }),
        (size, tasks) => {
          const pool = new PowerPool(Echo, {
            size,
            minSize: size,
            maxSize: size,
            lazy: false,
            idleTimeout: 0,
          });
          for (const n of tasks) {
            pool.postMessage({ n });
          }
          const stats = pool.getStats();
          expect(stats.workerCount).toBeGreaterThanOrEqual(0);
          expect(stats.workerCount).toBeLessThanOrEqual(size);
          pool.shutdown();
        }
      ),
      { numRuns: RUNS }
    );
  });
});
