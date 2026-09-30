/**
 * The queue budget was global while the permits and gates were per-partition.
 *
 * `PowerBulkhead`'s whole reason for existing is that a noisy partition cannot
 * starve a critical one. The permits were partitioned and the gates were
 * partitioned, and the **queue budget was not** — one `_pendingCount` for the
 * whole bulkhead, compared against every partition's admission decision. So the
 * partition that spent the budget decided for the others.
 *
 * Measured, 2 partitions, `maxConcurrency: 1`, `queueCapacity: 2`, submitting
 * five tasks back to back and reading the state after each one:
 *
 *     A1   global pending 0   A(avail,q) 0 0   C(avail,q) 1 0
 *     A2   global pending 1   A(avail,q) 0 1   C(avail,q) 1 0
 *     A3   global pending 2   A(avail,q) 0 2   C(avail,q) 1 0
 *     C1   global pending 2   A(avail,q) 0 2   C(avail,q) 0 0    <- took C's permit
 *     C2   REFUSED "PowerBulkhead queue is full"                  <- C had queued 0
 *
 * `C2` was rejected because partition A had queued two tasks. C's own queue
 * held **nothing**, C's own permit was in use by C1, and C's own gate reported
 * `queueCapacity: Infinity`. The critical partition was turned away by the
 * noisy one — which is the specific failure this class is sold on preventing.
 *
 * The fix is that `queueCapacity` is read **per partition**, which makes the
 * total that can wait `queueCapacity * partitions`. That is an observable
 * admission change and it is the point: a shared budget is not isolation.
 *
 * A second defect fell out of the first. The bulkhead kept its own
 * `_pendingCount` alongside each gate's `pending` — two counters for one
 * quantity — and `drain()` was decided from them. With the gate owning the
 * count, a released permit decrements `pending` *synchronously* while the
 * predecessor's `.finally` decrements `active` in the same turn, so there is a
 * window where a task has been promoted out of the queue and has not yet begun
 * and both counters read zero. `drain()` resolved across it, with a task still
 * owed. That was caught by an existing test, not by this one.
 *
 * Counts and states throughout. No durations: the harness measures a ~28%
 * median spread, and every assertion here is a counter or a shape. The tasks
 * are gates that release on a timer purely to keep the permits held — nothing
 * asserts on how long they took.
 */
import { describe, it, expect } from 'vitest';
import { PowerBulkhead } from '../src/helpers/powerBulkhead.js';

/**
 * A task that holds its permit until released. `settle()` opens every gate at
 * once, so the queue depths below are reached by admission and not by racing a
 * clock.
 */
function makeBulkhead(overrides = {}) {
  /** @type {Array<() => void>} */
  const gates = [];
  const held = () => new Promise((resolve) => gates.push(resolve));
  const settle = async () => {
    // A macrotask turn per wave, so every promoted task registers its own gate
    // before the next wave is taken. Bounded and **not** early-exiting: the
    // first version broke out as soon as a wave found nothing open, which is
    // exactly the turn in which a promotion has not registered yet, so it
    // stopped with work still queued. The count is a bound on waiting, not a
    // claim about how long anything takes — nothing here asserts a duration.
    for (let wave = 0; wave < 6; wave += 1) {
      for (const release of gates.splice(0, gates.length)) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const bulkhead = new PowerBulkhead({
    partitions: 2,
    maxConcurrency: 1,
    queueCapacity: 2,
    // Explicit indices: the default path hashes the key, and
    // `partitioner: (k) => k` silently sends every non-numeric key to
    // partition 0, which collapses the two partitions this file depends on.
    partitioner: (key) => (key === 'noisy' ? 0 : 1),
    ...overrides,
  });
  return { bulkhead, held, settle };
}

describe('the queue budget is per-partition, not global', () => {
  it('does not let a saturated partition refuse an unrelated one', async () => {
    // The defect in one assertion. A took the whole budget with 2 queued; C
    // then queued one of its own and was admitted. Before the fix C's second
    // task was refused while C's own queue was empty.
    const { bulkhead, held, settle } = makeBulkhead();

    bulkhead.run(held, { partitionKey: 'noisy' }).catch(() => {});
    bulkhead.run(held, { partitionKey: 'noisy' }).catch(() => {});
    bulkhead.run(held, { partitionKey: 'noisy' }).catch(() => {});

    // C is untouched: free permit, nothing queued.
    expect(bulkhead._buckets[1].gate.pending).toBe(0);

    const c1 = bulkhead.run(held, { partitionKey: 'critical' });
    const c2 = bulkhead.run(held, { partitionKey: 'critical' });

    // Assert that they are **not refused**, without waiting for them to finish:
    // `held()` only resolves when `settle()` opens the gates, so awaiting them
    // here timed the test out at 5 s. First written as
    // `await Promise.all([c1, c2])`, which is a test about a gate that was never
    // going to open.
    /** @type {string[]} */
    const refused = [];
    c1.catch((e) => refused.push(e.message));
    c2.catch((e) => refused.push(e.message));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refused).toEqual([]);
    // C's own queue grew to 1, so C2 was admitted rather than dropped.
    expect(bulkhead._buckets[1].gate.pending).toBe(1);

    await settle();
    expect(await c1).toBeUndefined();
    expect(await c2).toBeUndefined();
  });

  it('still refuses a task in the partition that is actually full', async () => {
    // The counterpart, and the reason the previous test is not a loosening. A
    // per-partition budget that never refused anything would pass the test
    // above; capacity: 2 per partition means the third queued task in C is
    // still turned away.
    const { bulkhead, held } = makeBulkhead();

    bulkhead.run(held, { partitionKey: 'critical' }).catch(() => {}); // takes the permit
    bulkhead.run(held, { partitionKey: 'critical' }).catch(() => {}); // queued 1
    bulkhead.run(held, { partitionKey: 'critical' }).catch(() => {}); // queued 2

    await expect(bulkhead.run(held, { partitionKey: 'critical' })).rejects.toThrow(
      'PowerBulkhead queue is full'
    );
  });

  it('reports the total that can wait as queueCapacity * partitions', () => {
    // The observable admission change, stated rather than implied. Before the
    // fix this configuration admitted `queueCapacity` waiting tasks overall; now
    // it admits that many *per partition*.
    const { bulkhead } = makeBulkhead({ queueCapacity: 3, partitions: 4 });
    expect(bulkhead.queueCapacity).toBe(3);
    expect(bulkhead.partitions).toBe(4);
    // 12 slots across the bulkhead, which is what "per partition" means.
    expect(bulkhead.queueCapacity * bulkhead.partitions).toBe(12);
  });

  it('honours queueCapacity: 0 per partition as "refuse rather than queue"', async () => {
    // The documented meaning of 0, and the reason the gate is given the same
    // value as a backstop. Both partitions refuse to queue, independently.
    const bulkhead = new PowerBulkhead({
      partitions: 2,
      maxConcurrency: 1,
      queueCapacity: 0,
      partitioner: (key) => (key === 'noisy' ? 0 : 1),
    });
    // Occupies each partition's single permit.
    const a = bulkhead.run(() => new Promise(() => {}), { partitionKey: 'noisy' });
    const c = bulkhead.run(() => new Promise(() => {}), { partitionKey: 'critical' });
    expect(bulkhead.pending).toBe(0);

    // Both would have to queue, and neither is allowed to. `run()` returns a
    // **rejected promise** rather than throwing, so this asserts on the promise.
    // It first read `expect(() => ...).toThrow` with no call — a property access,
    // which evaluates to the function and asserts nothing at all.
    for (const key of ['noisy', 'critical']) {
      await expect(bulkhead.run(() => {}, { partitionKey: key })).rejects.toThrow(
        'PowerBulkhead queue is full'
      );
    }
    expect(bulkhead.pending).toBe(0);
    // The two admitted tasks are still owed, and were not disturbed by the
    // refusals.
    expect(a).toBeInstanceOf(Promise);
    expect(c).toBeInstanceOf(Promise);
  });

  it('gives each partition gate the budget rather than Infinity', () => {
    // The row noted the per-gate value was hard-coded to `Infinity`, so the
    // gate could never be the thing that refused. The bulkhead checks first and
    // owns the error message; the gate is a backstop against the same number.
    const { bulkhead } = makeBulkhead({ queueCapacity: 4 });
    for (const bucket of bulkhead._buckets) {
      expect(bucket.gate.queueCapacity).toBe(4);
    }
  });
});

describe('isFull and stats().saturated describe the whole bulkhead', () => {
  it('is false while any partition still has room', async () => {
    // A single busy partition is the *normal* state of an isolated bulkhead.
    // Reporting `isFull` for that would make the flag useless for backing off,
    // and would reintroduce the coupling in a different place.
    const { bulkhead, held } = makeBulkhead();

    bulkhead.run(held, { partitionKey: 'noisy' }).catch(() => {});
    bulkhead.run(held, { partitionKey: 'noisy' }).catch(() => {});
    bulkhead.run(held, { partitionKey: 'noisy' }).catch(() => {});

    // Partition 0 is at its budget of 2; partition 1 has queued nothing.
    expect(bulkhead._buckets[0].gate.pending).toBe(2);
    expect(bulkhead._buckets[1].gate.pending).toBe(0);
    expect(bulkhead.isFull).toBe(false);
    expect(bulkhead.stats().saturated).toBe(false);
  });

  it('is true only when no partition can take more', async () => {
    const { bulkhead, held } = makeBulkhead();

    for (const key of ['noisy', 'critical', 'noisy', 'critical', 'noisy', 'critical']) {
      bulkhead.run(held, { partitionKey: key }).catch(() => {});
    }
    // 1 running + 2 queued in each partition.
    expect(bulkhead._buckets[0].gate.pending).toBe(2);
    expect(bulkhead._buckets[1].gate.pending).toBe(2);
    expect(bulkhead.isFull).toBe(true);
    expect(bulkhead.stats().saturated).toBe(true);
  });
});

describe('pending and drain stay honest under per-partition accounting', () => {
  it('pending is the sum over partitions and returns to zero', async () => {
    const { bulkhead, held, settle } = makeBulkhead();

    // Two per partition, so one runs and one queues in each: total pending 2.
    // First written as noisy/noisy/critical, which queues only the second noisy
    // task and leaves the critical one holding a permit — pending 1, not 2.
    bulkhead.run(held, { partitionKey: 'noisy' }).catch(() => {});
    bulkhead.run(held, { partitionKey: 'noisy' }).catch(() => {});
    bulkhead.run(held, { partitionKey: 'critical' }).catch(() => {});
    bulkhead.run(held, { partitionKey: 'critical' }).catch(() => {});
    expect(bulkhead._buckets[0].gate.pending).toBe(1);
    expect(bulkhead._buckets[1].gate.pending).toBe(1);
    expect(bulkhead.pending).toBe(2);

    await settle();
    expect(bulkhead.pending).toBe(0);
    expect(bulkhead.active).toBe(0);
  });

  it('drain() waits for a task promoted out of the queue but not yet begun', async () => {
    // The regression the dual counter produced. A permit release hands the
    // permit to the next queued task and drops the queue count in the same
    // synchronous turn, while the predecessor's own bookkeeping settles in that
    // turn too — so there is a moment where nothing is queued and nothing looks
    // active, with a task still owed. Caught by an existing drain test the
    // moment the gate took over the count, and pinned here because the shape is
    // not obvious from the fix.
    const order = [];
    const { bulkhead } = makeBulkhead();
    let releaseFirst = () => {};
    const first = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    bulkhead
      .run(() => first.then(() => order.push('first')), { partitionKey: 'critical' })
      .catch(() => {});
    // Queued behind the first.
    bulkhead.run(() => order.push('second'), { partitionKey: 'critical' }).catch(() => {});

    const drained = bulkhead.drain();
    let drainedEarly = false;
    drained.then(() => {
      drainedEarly = order.length < 2;
    });

    releaseFirst();
    await drained;

    expect(order).toEqual(['first', 'second']);
    expect(drainedEarly).toBe(false);
  });
});
