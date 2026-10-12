import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * FEAT-002: task priorities for `PowerPool`.
 *
 * Higher-priority tasks must jump ahead of lower-priority ones in the queue
 * when the pool is saturated. Equal-priority tasks keep FIFO order.
 */

/** A worker that accepts a message and never answers, so tasks stay in flight. */
function Busy() {
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  this.postMessage = () => {};
  this.terminate = () => {};
}

/**
 * A saturated pool with task queue enabled, so every post goes through the
 * queue and is later dispatched by `shiftHighestPriority`.
 */
function saturatedPoolWithQueue(options = {}) {
  const pool = new PowerPool(Busy, {
    size: 1,
    minSize: 1,
    maxSize: 1,
    lazy: false,
    taskQueue: true,
    maxTasksPerWorker: 1,
    queuePolicy: 'enqueue',
    maxQueueLength: 10,
    ...options,
  });
  // occupy the single worker so everything queues
  pool.postMessage({ n: 'occupying' });
  expect(pool.queue.length).toBe(0);
  return pool;
}

/**
 * Dispatch the next queued item, whichever queue implementation the pool built.
 *
 * PISC-004 replaced the O(n) `shiftHighestPriority` scan with a heap on the
 * default path, so the queue is a `PowerPriorityQueue` whose `shift()` already
 * returns highest-priority-then-FIFO. The aging path still uses `PowerQueue` and
 * its scan, because a drifting key cannot be held in a static heap.
 *
 * The helper keeps these tests asserting the *invariant* — which item comes next
 * — rather than the mechanism, so they pin the same behaviour on both paths.
 */
function dispatchNext(pool) {
  return pool._usesPriorityHeap
    ? pool.queue.shift()
    : pool.queue.shiftHighestPriority((item) => item.priority ?? 0);
}

describe('PowerPool task priority', () => {
  it('defaults to priority 0 when not specified', () => {
    const pool = saturatedPoolWithQueue();
    pool.postMessage('a');
    pool.postMessage('b');
    expect(pool.queue.length).toBe(2);
    expect(pool.queue.toArray().map((q) => q.priority ?? 0)).toEqual([0, 0]);
  });

  it('stores explicit priority on queued items', () => {
    const pool = saturatedPoolWithQueue();
    pool.postMessage('low', undefined, { priority: 1 });
    pool.postMessage('high', undefined, { priority: 5 });
    // Dispatch order, not insertion order: `toArray()` on a priority queue
    // answers "what would I get if I drained this", which is the useful question.
    expect(pool.queue.toArray().map((q) => q.priority)).toEqual([5, 1]);
  });

  it('dispatches higher priority before lower priority when saturated', () => {
    const pool = saturatedPoolWithQueue();
    pool.postMessage('low', undefined, { priority: 1 });
    pool.postMessage('high', undefined, { priority: 5 });
    pool.postMessage('medium', undefined, { priority: 3 });

    // Dispatch order, not insertion order — see `toArray()`.
    const queued = pool.queue.toArray().map((q) => q.message);
    expect(queued).toEqual(['high', 'medium', 'low']);

    // simulate worker becoming free: dispatch should pull highest first
    const dispatch1 = dispatchNext(pool);
    expect(dispatch1.message).toBe('high');

    const dispatch2 = dispatchNext(pool);
    expect(dispatch2.message).toBe('medium');

    const dispatch3 = dispatchNext(pool);
    expect(dispatch3.message).toBe('low');
  });

  it('maintains FIFO order among equal-priority tasks', () => {
    const pool = saturatedPoolWithQueue();
    pool.postMessage('a', undefined, { priority: 2 });
    pool.postMessage('b', undefined, { priority: 2 });
    pool.postMessage('c', undefined, { priority: 2 });

    const dispatch1 = dispatchNext(pool);
    expect(dispatch1.message).toBe('a');

    const dispatch2 = dispatchNext(pool);
    expect(dispatch2.message).toBe('b');

    const dispatch3 = dispatchNext(pool);
    expect(dispatch3.message).toBe('c');
  });

  it('accepts priority aging to bound low-priority starvation', () => {
    const pool = saturatedPoolWithQueue({ priorityAgingMs: 100 });
    pool.postMessage('old', undefined, { priority: 0 });
    pool.postMessage('new', undefined, { priority: 5 });
    const [old, fresh] = pool.queue.toArray();
    old.enqueuedAt -= 1000;
    const next = pool.queue.shiftHighestPriority(
      (item) => (item.priority ?? 0) + (Date.now() - item.enqueuedAt) / pool._priorityAgingMs
    );
    expect(next.message).toBe('old');
    expect(fresh.message).toBe('new');
  });

  it('allows negative priorities and orders them correctly', () => {
    const pool = saturatedPoolWithQueue();
    pool.postMessage('neg', undefined, { priority: -5 });
    pool.postMessage('zero', undefined, { priority: 0 });
    pool.postMessage('pos', undefined, { priority: 10 });

    const dispatch1 = dispatchNext(pool);
    expect(dispatch1.message).toBe('pos');

    const dispatch2 = dispatchNext(pool);
    expect(dispatch2.message).toBe('zero');

    const dispatch3 = dispatchNext(pool);
    expect(dispatch3.message).toBe('neg');
  });

  it('mixes explicit and default priorities correctly', () => {
    const pool = saturatedPoolWithQueue();
    pool.postMessage('default-a');
    pool.postMessage('explicit-high', undefined, { priority: 10 });
    pool.postMessage('default-b');
    pool.postMessage('explicit-low', undefined, { priority: -1 });

    const dispatch1 = dispatchNext(pool);
    expect(dispatch1.message).toBe('explicit-high');

    const dispatch2 = dispatchNext(pool);
    expect(dispatch2.message).toBe('default-a');

    const dispatch3 = dispatchNext(pool);
    expect(dispatch3.message).toBe('default-b');

    const dispatch4 = dispatchNext(pool);
    expect(dispatch4.message).toBe('explicit-low');
  });

  it('works with drop-oldest queue policy', () => {
    const pool = saturatedPoolWithQueue({ queuePolicy: 'drop-oldest', maxQueueLength: 2 });
    pool.postMessage('low', undefined, { priority: 1 });
    pool.postMessage('high', undefined, { priority: 5 });
    pool.postMessage('medium', undefined, { priority: 3 });
    // drop-oldest evicts the oldest to make room; with maxQueueLength: 2 and
    // three posts, only the newest survives
    expect(pool.queue.length).toBe(1);
    expect(pool.queue.toArray().map((q) => q.message)).toEqual(['medium']);
  });

  it('works with drop-newest queue policy', () => {
    const pool = saturatedPoolWithQueue({ queuePolicy: 'drop-newest' });
    pool.postMessage('low', undefined, { priority: 1 });
    // drop-newest refuses the newcomer when queue is non-empty
    const refused = pool.postMessage('high', undefined, { priority: 5 });
    expect(refused).toBe(false);
    expect(pool.queue.length).toBe(1);
  });

  it('works with reject queue policy', () => {
    const pool = saturatedPoolWithQueue({ queuePolicy: 'reject' });
    const accepted = pool.postMessage('low', undefined, { priority: 1 });
    expect(accepted).toBe(false);
    expect(pool.queue.length).toBe(0);
  });

  it('preserves priority through postMessageBatch', () => {
    const pool = saturatedPoolWithQueue();
    const results = pool.postMessageBatch(
      [
        { message: 'a', transfer: undefined },
        { message: 'b', transfer: undefined },
        { message: 'c', transfer: undefined },
      ],
      { priority: 7 }
    );
    expect(results).toEqual([true, true, true]);
    expect(pool.queue.length).toBe(3);
    expect(pool.queue.toArray().map((q) => q.priority)).toEqual([7, 7, 7]);
  });

  it('returns undefined when dispatching from an empty queue', () => {
    const pool = saturatedPoolWithQueue();
    expect(dispatchNext(pool)).toBeUndefined();
  });
});

describe('PISC-004 the heap dispatch path', () => {
  // The saturated dispatch path used to call `PowerQueue.shiftHighestPriority`,
  // which scans every queued item to find the best one — O(n) per dispatch, so
  // draining a saturated queue was O(n²). Under sustained saturation that is the
  // difference between a pool that keeps up and one that falls behind
  // progressively, and it matters more here than in Piscina: a long pause on a
  // browser main thread is a dropped frame.
  //
  // **The split is the design, and these tests pin both halves.** The heap keys on
  // `item.priority` at push time. `priorityAgingMs` makes the *effective* priority
  // `priority + (now - enqueuedAt) / priorityAgingMs`, which drifts with the clock
  // — so a static heap would order by a key that is already stale. Aging therefore
  // stays on the O(n) scan, and the heap is used when aging is off, which is the
  // default and the case that saturates.

  it('builds a heap by default, and a ring buffer when aging is on', () => {
    const heap = saturatedPoolWithQueue();
    expect(heap.queue.constructor.name).toBe('PowerPriorityQueue');
    expect(heap._usesPriorityHeap).toBe(true);

    const aging = saturatedPoolWithQueue({ priorityAgingMs: 100 });
    expect(aging.queue.constructor.name).toBe('PowerQueue');
    expect(aging._usesPriorityHeap).toBe(false);
  });

  it('dispatches the same order on both paths for the same input', () => {
    // The property that makes the split safe: swapping the structure must not
    // change what a caller observes. Same posts, same priorities, same expected
    // sequence — asserted through `dispatchNext`, which uses whichever path the
    // pool built.
    const expected = ['high', 'med-a', 'med-b', 'low'];

    const heap = saturatedPoolWithQueue();
    heap.postMessage('low', undefined, { priority: 1 });
    heap.postMessage('high', undefined, { priority: 5 });
    heap.postMessage('med-a', undefined, { priority: 3 });
    heap.postMessage('med-b', undefined, { priority: 3 });
    expect(
      [dispatchNext(heap), dispatchNext(heap), dispatchNext(heap), dispatchNext(heap)].map(
        (i) => i.message
      )
    ).toEqual(expected);

    const aging = saturatedPoolWithQueue({ priorityAgingMs: 100000 });
    aging.postMessage('low', undefined, { priority: 1 });
    aging.postMessage('high', undefined, { priority: 5 });
    aging.postMessage('med-a', undefined, { priority: 3 });
    aging.postMessage('med-b', undefined, { priority: 3 });
    expect(
      [dispatchNext(aging), dispatchNext(aging), dispatchNext(aging), dispatchNext(aging)].map(
        (i) => i.message
      )
    ).toEqual(expected);
  });

  it('keeps FIFO among equal priorities through the heap', () => {
    // The invariant PISC-004's own note calls out. `PowerPriorityQueue` breaks
    // priority ties on an insertion sequence number, which is FIFO — the same
    // invariant `PowerQueue.shiftHighestPriority` documents.
    const pool = saturatedPoolWithQueue();
    for (const name of ['a', 'b', 'c', 'd']) pool.postMessage(name, undefined, { priority: 2 });
    expect(
      [dispatchNext(pool), dispatchNext(pool), dispatchNext(pool), dispatchNext(pool)].map(
        (i) => i.message
      )
    ).toEqual(['a', 'b', 'c', 'd']);
  });

  it('still drops expired deadlines while dispatching from the heap', () => {
    // The dispatch loop shifts until it finds a non-expired item, and that loop
    // runs on the heap path too. A heap that returned items in the wrong order
    // here would silently dispatch expired work or discard live work.
    const pool = saturatedPoolWithQueue();
    pool.postMessage('expired', undefined, { priority: 9, deadlineAt: Date.now() - 1000 });
    pool.postMessage('live', undefined, { priority: 1 });
    const next = dispatchNext(pool);
    expect(next.message).toBe('live');
  });

  it('reports the same queue length on both paths', () => {
    // `length` is read 28 times across the pool, including by `queuePressure` and
    // the saturation checks. A structure that reported it differently would change
    // admission behaviour, not just dispatch order.
    const heap = saturatedPoolWithQueue();
    const aging = saturatedPoolWithQueue({ priorityAgingMs: 100 });
    for (const p of [heap, aging]) {
      p.postMessage('a');
      p.postMessage('b');
      p.postMessage('c');
    }
    expect(heap.queue.length).toBe(3);
    expect(aging.queue.length).toBe(3);
  });
});
