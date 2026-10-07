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
    expect(pool.queue.toArray().map((q) => q.priority)).toEqual([1, 5]);
  });

  it('dispatches higher priority before lower priority when saturated', () => {
    const pool = saturatedPoolWithQueue();
    pool.postMessage('low', undefined, { priority: 1 });
    pool.postMessage('high', undefined, { priority: 5 });
    pool.postMessage('medium', undefined, { priority: 3 });

    const queued = pool.queue.toArray().map((q) => q.message);
    expect(queued).toEqual(['low', 'high', 'medium']);

    // simulate worker becoming free: dispatch should pull highest first
    const dispatch1 = pool.queue.shiftHighestPriority((item) => item.priority ?? 0);
    expect(dispatch1.message).toBe('high');

    const dispatch2 = pool.queue.shiftHighestPriority((item) => item.priority ?? 0);
    expect(dispatch2.message).toBe('medium');

    const dispatch3 = pool.queue.shiftHighestPriority((item) => item.priority ?? 0);
    expect(dispatch3.message).toBe('low');
  });

  it('maintains FIFO order among equal-priority tasks', () => {
    const pool = saturatedPoolWithQueue();
    pool.postMessage('a', undefined, { priority: 2 });
    pool.postMessage('b', undefined, { priority: 2 });
    pool.postMessage('c', undefined, { priority: 2 });

    const dispatch1 = pool.queue.shiftHighestPriority((item) => item.priority ?? 0);
    expect(dispatch1.message).toBe('a');

    const dispatch2 = pool.queue.shiftHighestPriority((item) => item.priority ?? 0);
    expect(dispatch2.message).toBe('b');

    const dispatch3 = pool.queue.shiftHighestPriority((item) => item.priority ?? 0);
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

    const dispatch1 = pool.queue.shiftHighestPriority((item) => item.priority ?? 0);
    expect(dispatch1.message).toBe('pos');

    const dispatch2 = pool.queue.shiftHighestPriority((item) => item.priority ?? 0);
    expect(dispatch2.message).toBe('zero');

    const dispatch3 = pool.queue.shiftHighestPriority((item) => item.priority ?? 0);
    expect(dispatch3.message).toBe('neg');
  });

  it('mixes explicit and default priorities correctly', () => {
    const pool = saturatedPoolWithQueue();
    pool.postMessage('default-a');
    pool.postMessage('explicit-high', undefined, { priority: 10 });
    pool.postMessage('default-b');
    pool.postMessage('explicit-low', undefined, { priority: -1 });

    const dispatch1 = pool.queue.shiftHighestPriority((item) => item.priority ?? 0);
    expect(dispatch1.message).toBe('explicit-high');

    const dispatch2 = pool.queue.shiftHighestPriority((item) => item.priority ?? 0);
    expect(dispatch2.message).toBe('default-a');

    const dispatch3 = pool.queue.shiftHighestPriority((item) => item.priority ?? 0);
    expect(dispatch3.message).toBe('default-b');

    const dispatch4 = pool.queue.shiftHighestPriority((item) => item.priority ?? 0);
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

  it('returns undefined from shiftHighestPriority on empty queue', () => {
    const pool = saturatedPoolWithQueue();
    expect(pool.queue.shiftHighestPriority((item) => item.priority ?? 0)).toBeUndefined();
  });
});
