import { describe, it, expect } from 'vitest';
import { PowerPermitGate } from '../src/helpers/powerPermitGate.js';
import { PowerBulkhead } from '../src/helpers/powerBulkhead.js';
import { PowerQueue } from '../src/helpers/powerQueue.js';

/**
 * GAP-007: weighted acquisition on the permit-gate family.
 *
 * Each assertion is a counter or a shape, never a duration — the harness measures
 * a ~28% median min/max spread, and an assertion in milliseconds is an assertion
 * about the machine.
 */
describe('GAP-007: weighted acquisition', () => {
  describe('PowerPermitGate — default weight is 1', () => {
    it('acquire() with no weight behaves as weight=1', async () => {
      const gate = new PowerPermitGate({ capacity: 2 });
      const a = await gate.acquire();
      expect(gate.available).toBe(1);
      expect(gate.active).toBe(1);
      a();
      expect(gate.available).toBe(2);
      expect(gate.active).toBe(0);
    });

    it('tryAcquire() with no weight behaves as weight=1', () => {
      const gate = new PowerPermitGate({ capacity: 1 });
      const r = gate.tryAcquire();
      expect(typeof r).toBe('function');
      expect(gate.tryAcquire()).toBeNull();
      r();
      expect(gate.tryAcquire()).not.toBeNull();
    });

    it('acquire({ weight: 1 }) is identical to weightless acquire', async () => {
      const gate = new PowerPermitGate({ capacity: 2 });
      const a = await gate.acquire({ weight: 1 });
      expect(gate.available).toBe(1);
      expect(gate.active).toBe(1);
      const b = await gate.acquire({ weight: 1 });
      expect(gate.available).toBe(0);
      expect(gate.active).toBe(2);
      a();
      b();
      expect(gate.available).toBe(2);
      expect(gate.active).toBe(0);
    });

    it('maintains the capacity invariant: available + active === capacity', async () => {
      const gate = new PowerPermitGate({ capacity: 5 });
      const a = await gate.acquire({ weight: 2 });
      const b = await gate.acquire({ weight: 3 });
      expect(gate.available + gate.active).toBe(5);
      a();
      expect(gate.available + gate.active).toBe(5);
      b();
      expect(gate.available + gate.active).toBe(5);
    });
  });

  describe('PowerPermitGate — weighted block and grant', () => {
    it('a weight-N caller occupies N units immediately', async () => {
      const gate = new PowerPermitGate({ capacity: 5 });
      const held = await gate.acquire({ weight: 3 });
      expect(gate.available).toBe(2);
      expect(gate.active).toBe(3);
      held();
      expect(gate.available).toBe(5);
      expect(gate.active).toBe(0);
    });

    it('a weight-N caller that does not fit fast-paths queues instead', async () => {
      const gate = new PowerPermitGate({ capacity: 5, queueCapacity: 4 });
      const h3 = await gate.acquire({ weight: 3 }); // available = 2
      expect(gate.available).toBe(2);

      // A weight-3 caller needs 3, only 2 available → must queue
      const w3 = gate.acquire({ weight: 3 });
      expect(gate.pending).toBe(1);
      expect(gate.active).toBe(3);

      // Fill the remaining 2 with a weight-2 acquire
      const h2 = await gate.acquire({ weight: 2 });
      expect(gate.available).toBe(0);
      expect(gate.active).toBe(5);
      expect(gate.pending).toBe(1);

      // Releasing 2 units: w3 (3) does not fit in 2
      h2();
      await Promise.resolve();
      expect(gate.available).toBe(2);
      expect(gate.active).toBe(3);
      expect(gate.pending).toBe(1);

      // Releasing 3 more units: w3 (3) fits in 3
      h3();
      const release = await w3;
      expect(gate.pending).toBe(0);
      expect(gate.available).toBe(2);
      expect(gate.active).toBe(3);
      release();
      expect(gate.available).toBe(5);
      expect(gate.active).toBe(0);
    });

    it('release callback returns exactly weight units', async () => {
      const gate = new PowerPermitGate({ capacity: 5 });
      const held = await gate.acquire({ weight: 3 });
      held();
      // All 5 units available, so a weight-2 acquire can now proceed
      const held2 = await gate.acquire({ weight: 2 });
      expect(gate.available).toBe(3);
      expect(gate.active).toBe(2);
      held2();
      expect(gate.available).toBe(5);
      expect(gate.active).toBe(0);
    });
  });

  describe('PowerPermitGate — partial occupancy and FIFO ordering', () => {
    it('leaves room for smaller acquires while blocking larger ones', async () => {
      const gate = new PowerPermitGate({ capacity: 5, queueCapacity: 4 });
      const held = await gate.acquire({ weight: 3 }); // available = 2
      expect(gate.available).toBe(2);

      // A weight-2 caller fits in the remaining 2
      const small = await gate.acquire({ weight: 2 });
      expect(gate.available).toBe(0);
      expect(gate.active).toBe(5);

      // A weight-3 caller must queue
      const big = gate.acquire({ weight: 3 });
      expect(gate.pending).toBe(1);

      // Release 2 units: big (3) doesn't fit in 2
      small();
      await Promise.resolve();
      expect(gate.available).toBe(2);
      expect(gate.active).toBe(3);
      expect(gate.pending).toBe(1);

      // Release 3 more units: big (3) fits in 3
      held();
      const release = await big;
      expect(gate.available).toBe(2);
      expect(gate.active).toBe(3);
      release();
      expect(gate.available).toBe(5);
      expect(gate.active).toBe(0);
    });

    it('serves waiters in FIFO order, stopping at one that does not fit', async () => {
      const gate = new PowerPermitGate({ capacity: 5, queueCapacity: 4 });
      const h3 = await gate.acquire({ weight: 3 }); // available = 2
      const h2 = await gate.acquire({ weight: 2 }); // available = 0

      // Queue: weight-3 waiter first, then weight-2 waiter
      const w3 = gate.acquire({ weight: 3 });
      const w2 = gate.acquire({ weight: 2 });
      expect(gate.pending).toBe(2);

      // Release h2 (2 units): w3 (3) doesn't fit in 2, both stay queued
      h2();
      await Promise.resolve();
      expect(gate.pending).toBe(2);
      expect(gate.available).toBe(2);
      expect(gate.active).toBe(3);

      // Release h3 (3 units): w3 (3) fits in 3, w2 (2) doesn't (2 > 0)
      h3();
      const r3 = await w3;
      expect(gate.pending).toBe(1);
      expect(gate.active).toBe(3);
      expect(gate.available).toBe(2);

      // Release w3 (3 units): w2 (2) fits in 3
      r3();
      const r2 = await w2;
      expect(gate.pending).toBe(0);
      expect(gate.active).toBe(2);
      expect(gate.available).toBe(3);

      r2();
      expect(gate.available).toBe(5);
      expect(gate.active).toBe(0);
    });

    it('a queued weight-1 waiter is served by a partial release', async () => {
      const gate = new PowerPermitGate({ capacity: 3, queueCapacity: 4 });
      const h3 = await gate.acquire({ weight: 3 }); // available = 0
      const w1 = gate.acquire({ weight: 1 });
      expect(gate.pending).toBe(1);

      // Release 3 units: w1 (1) fits in 3
      h3();
      const release = await w1;
      expect(gate.pending).toBe(0);
      expect(gate.active).toBe(1);
      expect(gate.available).toBe(2);
      release();
      expect(gate.available).toBe(3);
      expect(gate.active).toBe(0);
    });
  });

  describe('PowerPermitGate — abort and cancel', () => {
    it('an aborted weight-N waiter consumes no units and is skipped on serve', async () => {
      const gate = new PowerPermitGate({ capacity: 3, queueCapacity: 4 });
      const held = await gate.acquire({ weight: 3 });
      expect(gate.available).toBe(0);
      expect(gate.active).toBe(3);

      const controller = new AbortController();
      const aborted = gate.acquire({ weight: 3, signal: controller.signal });
      controller.abort();
      await expect(aborted).rejects.toThrow(/abort/i);

      // The aborted entry is physically in the queue but marked cancelled.
      expect(gate.pending).toBe(0);

      // Releasing 3 units: the corpse is compacted, no permit consumed,
      // all 3 units come back to the pool.
      held();
      await Promise.resolve();
      expect(gate.available).toBe(3);
      expect(gate.active).toBe(0);
      expect(gate.pending).toBe(0);
    });

    it('a live waiter behind an aborted weight-N one is still served', async () => {
      const gate = new PowerPermitGate({ capacity: 5, queueCapacity: 4 });
      const held = await gate.acquire({ weight: 5 });

      const controller = new AbortController();
      const corpse = gate.acquire({ weight: 3, signal: controller.signal });
      const live = gate.acquire({ weight: 1 });
      controller.abort();
      await expect(corpse).rejects.toThrow(/abort/i);
      expect(gate.pending).toBe(1); // only the live one

      // Release 5 units: corpse (3) is compacted at head, live (1) is served
      held();
      const release = await live;
      expect(gate.pending).toBe(0);
      expect(gate.active).toBe(1);
      expect(gate.available).toBe(4);
      release();
      expect(gate.available).toBe(5);
      expect(gate.active).toBe(0);
    });
  });

  describe('PowerPermitGate — validation', () => {
    it('rejects a NaN weight', async () => {
      const gate = new PowerPermitGate({ capacity: 5 });
      await expect(gate.acquire({ weight: NaN })).rejects.toThrow(TypeError);
    });

    it('rejects a zero weight', async () => {
      const gate = new PowerPermitGate({ capacity: 5 });
      await expect(gate.acquire({ weight: 0 })).rejects.toThrow(TypeError);
    });

    it('rejects a fractional weight', async () => {
      const gate = new PowerPermitGate({ capacity: 5 });
      await expect(gate.acquire({ weight: 2.5 })).rejects.toThrow(TypeError);
    });

    it('rejects an Infinity weight', async () => {
      const gate = new PowerPermitGate({ capacity: 5 });
      await expect(gate.acquire({ weight: Infinity })).rejects.toThrow(TypeError);
    });

    it('rejects a negative weight', async () => {
      const gate = new PowerPermitGate({ capacity: 5 });
      await expect(gate.acquire({ weight: -1 })).rejects.toThrow(TypeError);
    });

    it('rejects a weight exceeding capacity', async () => {
      const gate = new PowerPermitGate({ capacity: 5 });
      await expect(gate.acquire({ weight: 10 })).rejects.toThrow(TypeError);
      await expect(gate.acquire({ weight: 10 })).rejects.toThrow(/exceeds/);
    });

    it('tryAcquire rejects an invalid weight with TypeError', () => {
      const gate = new PowerPermitGate({ capacity: 5 });
      expect(() => gate.tryAcquire(0)).toThrow(TypeError);
      expect(() => gate.tryAcquire(NaN)).toThrow(TypeError);
      expect(() => gate.tryAcquire(2.5)).toThrow(TypeError);
    });

    it('tryAcquire returns null for a weight exceeding capacity', () => {
      // An unsatisfiable weight is a permanent "cannot acquire", so tryAcquire
      // returns null rather than throwing — the caller asked to try, and the
      // answer is "no".
      const gate = new PowerPermitGate({ capacity: 5 });
      expect(gate.tryAcquire(10)).toBeNull();
    });
  });

  describe('PowerBulkhead — weighted run/tryRun', () => {
    it('run({ weight: N }) acquires N units from the partition', async () => {
      const bulkhead = new PowerBulkhead({ partitions: 1, maxConcurrency: 3, queueCapacity: 4 });
      const running = bulkhead.run(() => 'done', { weight: 3 });
      // Fast-path: active and available are updated synchronously
      expect(bulkhead.active).toBe(1);
      expect(bulkhead._buckets[0].gate.available).toBe(0);
      await expect(running).resolves.toBe('done');
      expect(bulkhead.active).toBe(0);
      expect(bulkhead._buckets[0].gate.available).toBe(3);
    });

    it('run({ weight }) exceeding maxConcurrency rejects with TypeError', async () => {
      const bulkhead = new PowerBulkhead({ partitions: 1, maxConcurrency: 2 });
      await expect(bulkhead.run(() => 'x', { weight: 3 })).rejects.toThrow(TypeError);
      await expect(bulkhead.run(() => 'x', { weight: 3 })).rejects.toThrow(/exceeds/);
    });

    it('does not count a queued heavy task as active', async () => {
      // GAP-007: when available > 0 but available < weight, the task must still
      // queue and NOT be counted in `active` until it gets its permit. The
      // `willQueue` check must compare against `weight`, not against 0.
      const bulkhead = new PowerBulkhead({ partitions: 1, maxConcurrency: 3, queueCapacity: 4 });
      let release1;
      let resolveStarted;
      const started = new Promise((resolve) => {
        resolveStarted = resolve;
      });

      const first = bulkhead.run(
        () =>
          new Promise((resolve) => {
            release1 = () => resolve('a');
            resolveStarted();
          }),
        { weight: 2 }
      );
      void first;
      expect(bulkhead.active).toBe(1);
      expect(bulkhead._buckets[0].gate.available).toBe(1); // 1 unit still free

      // A weight-2 task can't run (only 1 unit free) — it must queue
      const queued = bulkhead.run(() => 'b', { weight: 2 });
      expect(bulkhead.pending).toBe(1);
      // The queued task should NOT be counted as active yet. With the mutation
      // (`willQueue = available === 0`), active would be 2 here because
      // `available` is 1 (not 0), so the task is wrongly treated as fast-path.
      expect(bulkhead.active).toBe(1);

      await started;
      release1();
      await expect(queued).resolves.toBe('b');
      expect(bulkhead.active).toBe(0);
      expect(bulkhead.pending).toBe(0);
    });

    it('run({ weight }) queues when partition capacity is insufficient', async () => {
      const bulkhead = new PowerBulkhead({ partitions: 1, maxConcurrency: 2, queueCapacity: 4 });
      let release1;
      let resolveStarted;
      const started = new Promise((resolve) => {
        resolveStarted = resolve;
      });

      const first = bulkhead.run(
        () =>
          new Promise((resolve) => {
            release1 = () => resolve('a');
            resolveStarted();
          }),
        { weight: 2 }
      );
      void first;
      expect(bulkhead.active).toBe(1);

      // A weight-2 task can't start (0 units available), so it queues
      const queued = bulkhead.run(() => 'b', { weight: 2 });
      expect(bulkhead.pending).toBe(1);

      await started;
      release1();
      await expect(queued).resolves.toBe('b');
      expect(bulkhead.active).toBe(0);
      expect(bulkhead.pending).toBe(0);
    });

    it('tryRun({ weight: N }) acquires and returns a promise', async () => {
      const bulkhead = new PowerBulkhead({ partitions: 1, maxConcurrency: 3 });
      const result = bulkhead.tryRun(() => 'ok', { weight: 3 });
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBe('ok');
      expect(bulkhead.active).toBe(0);
    });

    it('tryRun({ weight }) returns null when capacity is insufficient', () => {
      const bulkhead = new PowerBulkhead({ partitions: 1, maxConcurrency: 2 });
      // Take both units
      const p = bulkhead.tryRun(() => new Promise(() => {}), { weight: 2 });
      expect(p).toBeInstanceOf(Promise);
      // Now available = 0, a weight-1 task can't acquire
      expect(bulkhead.tryRun(() => 'x', { weight: 1 })).toBeNull();
    });
  });

  describe('PowerQueue — totalWeight', () => {
    it('tracks the sum of item weights', () => {
      const q = new PowerQueue(4);
      q.push({ weight: 3 });
      q.push({ weight: 5 });
      expect(q.totalWeight).toBe(8);
      expect(q.length).toBe(2);
    });

    it('counts items without a weight property as 1', () => {
      const q = new PowerQueue(4);
      q.push(42);
      q.push('hello');
      q.push({ value: 1 });
      expect(q.totalWeight).toBe(3);
      expect(q.length).toBe(3);
    });

    it('decrements totalWeight on shift', () => {
      const q = new PowerQueue(4);
      q.push({ weight: 5 });
      q.push({ weight: 3 });
      expect(q.totalWeight).toBe(8);
      q.shift();
      expect(q.totalWeight).toBe(3);
      q.shift();
      expect(q.totalWeight).toBe(0);
    });

    it('resets totalWeight on clear', () => {
      const q = new PowerQueue(4);
      q.push({ weight: 10 });
      q.push({ weight: 5 });
      q.clear();
      expect(q.totalWeight).toBe(0);
      expect(q.length).toBe(0);
    });

    it('resets totalWeight on reset (clear alias)', () => {
      const q = new PowerQueue(4);
      q.push({ weight: 7 });
      q.reset();
      expect(q.totalWeight).toBe(0);
    });

    it('tracks fill with weighted items', () => {
      const q = new PowerQueue(4);
      q.fill({ weight: 2 }, 3);
      expect(q.totalWeight).toBe(6);
      expect(q.length).toBe(3);
    });

    it('tracks pushMany with mixed weights', () => {
      const q = new PowerQueue(4);
      q.pushMany([{ weight: 3 }, { weight: 5 }]);
      expect(q.totalWeight).toBe(8);
      expect(q.length).toBe(2);
    });

    it('tracks unshiftMany with mixed weights', () => {
      const q = new PowerQueue(4);
      q.push('a'); // weight 1
      q.unshiftMany([{ weight: 3 }, 'b']); // 3 + 1
      expect(q.totalWeight).toBe(5);
      expect(q.length).toBe(3);
    });

    it('stays zero when no items are pushed', () => {
      const q = new PowerQueue(4);
      expect(q.totalWeight).toBe(0);
      q.shift();
      expect(q.totalWeight).toBe(0);
    });

    it('stays in sync with length for weight-less items', () => {
      const q = new PowerQueue(4);
      q.pushMany([1, 2, 3, 4, 5]);
      expect(q.totalWeight).toBe(q.length);
      q.shift();
      expect(q.totalWeight).toBe(q.length);
    });
  });

  describe('PowerPermitGate — _waiters.totalWeight reflects queued weight', () => {
    it('the internal waiter queue tracks queued weights', async () => {
      const gate = new PowerPermitGate({ capacity: 4, queueCapacity: 4 });
      const held = await gate.acquire({ weight: 4 }); // available = 0
      const w1 = gate.acquire(); // queued, weight 1
      const w3 = gate.acquire({ weight: 3 }); // queued, weight 3
      expect(gate._waiters.totalWeight).toBe(4);
      held();
      await Promise.all([w1, w3]);
      expect(gate._waiters.totalWeight).toBe(0);
    });
  });
});
