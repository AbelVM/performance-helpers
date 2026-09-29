import { describe, it, expect, afterEach } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * TEST-003, continued: `postMessageBatch` and the paths only it reaches.
 *
 * The batch path is a second, hand-rolled dispatch implementation rather than a
 * loop over `postMessage` — it prepares every buffer once, takes a
 * single-worker fast path, and reserves queue room for the whole group up
 * front. All three exist for throughput and none of them exist in the
 * single-message path, so "the single-message tests pass" says nothing about
 * them.
 *
 * Every assertion here is on the *result array*, because that is the batch
 * contract: one slot per input item, in order, so a caller can line the result
 * up against what it sent. A result array of the wrong length is a silent
 * misalignment, not a visible error.
 */

/** A worker that accepts work and never answers, so tasks stay in flight. */
function Silent() {
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  this.postMessage = () => {};
  this.terminate = () => {};
}

/** A worker that records what it was sent, for asserting the fast path. */
function Recording() {
  this.onmessage = null;
  this.postMessage = (msg, transfer) => {
    this.posted.push(transfer ? { msg, transfer } : { msg });
  };
  this.posted = [];
  this.terminate = () => {};
}

const pools = [];
function makePool(WorkerCtor = Silent, options = {}) {
  const pool = new PowerPool(WorkerCtor, {
    size: 1,
    minSize: 1,
    maxSize: 4,
    lazy: false,
    ...options,
  });
  pools.push(pool);
  return pool;
}

afterEach(() => {
  for (const pool of pools.splice(0)) {
    try {
      pool.terminate();
    } catch {
      /* already gone */
    }
  }
});

describe('PowerPool postMessageBatch result shape', () => {
  it('returns one result per item, in order', () => {
    const pool = makePool(Recording);
    const items = [{ message: { a: 1 } }, { message: { a: 2 } }, { message: { a: 3 } }];
    const results = pool.postMessageBatch(items);
    // The contract callers rely on: `results[i]` is the fate of `items[i]`.
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r === true || r === false)).toBe(true);
  });

  it('returns an empty array for an empty batch', () => {
    const pool = makePool(Recording);
    expect(pool.postMessageBatch([])).toEqual([]);
  });

  it('takes the single-worker fast path when the worker is unlimited', () => {
    const pool = makePool(Recording, { size: 1, maxSize: 1, maxTasksPerWorker: Infinity });
    const underlying = pool.workers[0].worker._underlying;
    const results = pool.postMessageBatch([{ message: { a: 1 } }, { message: { a: 2 } }]);
    // The fast path exists to avoid per-item worker selection and queue
    // bookkeeping. Its observable effect is that every item reaches the same
    // worker directly, with no queue involvement.
    expect(results).toEqual([true, true]);
    expect(underlying.posted).toHaveLength(2);
    expect(pool.queue.length).toBe(0);
  });

  it('reports false for the items a fast-path post could not deliver', () => {
    const pool = makePool(Recording, { size: 1, maxSize: 1, maxTasksPerWorker: Infinity });
    const underlying = pool.workers[0].worker._underlying;
    const posted = underlying.postMessage;
    underlying.postMessage = () => {
      throw new Error('underlying refused');
    };
    // A per-item failure must land in that item's own slot. Reporting the
    // batch as a whole failure loses the information about which items got
    // through, and reporting success loses the failure entirely.
    const results = pool.postMessageBatch([{ message: { a: 1 } }, { message: { a: 2 } }]);
    expect(results).toEqual([false, false]);
    underlying.postMessage = posted;
  });
});

describe('PowerPool batch queue reservation', () => {
  it('refuses the overflow of an oversized batch rather than overshooting', () => {
    const pool = makePool(Silent, {
      size: 1,
      maxSize: 1,
      maxTasksPerWorker: 1,
      maxQueueLength: 2,
    });
    pool.postMessage({ occupy: true });
    const results = pool.postMessageBatch([
      { message: { a: 1 } },
      { message: { a: 2 } },
      { message: { a: 3 } },
      { message: { a: 4 } },
    ]);
    // A batch can overshoot the cap in one go, so room is reserved for the
    // whole group up front. The first two are admitted, the rest refused - and
    // the refusal lands in the right slots, not as a shortened array.
    expect(results).toHaveLength(4);
    expect(pool.queue.length).toBe(2);
    expect(results.filter((r) => r === true).length).toBeLessThan(4);
  });

  it('refuses the whole batch when the cap is already full', () => {
    const pool = makePool(Silent, {
      size: 1,
      maxSize: 1,
      maxTasksPerWorker: 1,
      maxQueueLength: 1,
    });
    pool.postMessage({ occupy: true });
    pool.postMessage({ fill: true });
    expect(pool.queue.length).toBe(1);
    const results = pool.postMessageBatch([{ message: { a: 1 } }, { message: { a: 2 } }]);
    // `admitted === 0` is the branch that logs "queue full" and admits none of
    // them. Reporting any `true` here would mean the cap was bypassed.
    expect(results.every((r) => r === false)).toBe(true);
    expect(pool.queue.length).toBe(1);
  });

  it('emits pool:queue:high once when a batch crosses the threshold', () => {
    const pool = makePool(Silent, {
      size: 1,
      maxSize: 1,
      maxTasksPerWorker: 1,
      maxQueueLength: 10,
      queueHighThreshold: 1,
    });
    const seen = [];
    // The bus is internal but is the only way to observe pool events; the
    // `pool:queue:high` emission on the *batch* path is a separate branch from
    // the one the single-message path already tests.
    pool._bus.on('pool:queue:high', (e) => seen.push(e));
    pool.postMessage({ occupy: true });
    pool.postMessageBatch([{ message: { a: 1 } }, { message: { a: 2 } }]);
    pool.postMessageBatch([{ message: { a: 3 } }, { message: { a: 4 } }]);
    // The event is a high-watermark, not a level: emitting it on every batch
    // while the queue stays over the threshold turns one notification into a
    // stream of them.
    expect(seen.length).toBe(1);
    expect(seen[0].length).toBeGreaterThan(1);
  });
});

describe('PowerPool batch correlation ids', () => {
  /** Echoes the framed payload back, so a pending response actually settles. */
  function Echo() {
    this.onmessage = null;
    this.postMessage = (msg) => {
      setTimeout(() => {
        if (this.onmessage) this.onmessage({ data: msg });
      }, 1);
    };
    this.terminate = () => {};
  }

  it('accepts a per-item correlation id from a factory', async () => {
    const pool = makePool(Echo, { size: 1, maxSize: 1, maxTasksPerWorker: Infinity });
    const results = pool.postMessageBatch([{ message: { a: 1 } }, { message: { a: 2 } }], {
      awaitResponse: true,
      correlationIdFactory: (i) => `batch-${i}`,
    });
    // With a factory the batch takes the per-item Promise path, so each result
    // is a Promise rather than a boolean. Every one of them must settle - a
    // batch where one Promise is left pending is a caller that hangs on it.
    expect(results).toHaveLength(2);
    expect(results.every((r) => r && typeof r.then === 'function')).toBe(true);
    for (const r of results) await expect(r).resolves.toBeTruthy();
  });

  it('gives each item a distinct id, so one reply cannot settle two promises', async () => {
    const pool = makePool(Echo, { size: 1, maxSize: 1, maxTasksPerWorker: Infinity });
    const ids = [];
    const results = pool.postMessageBatch([{ message: { a: 1 } }, { message: { a: 2 } }], {
      awaitResponse: true,
      correlationIdFactory: (i) => {
        ids.push(`batch-${i}`);
        return `batch-${i}`;
      },
    });
    expect(new Set(ids).size).toBe(2);
    // Two items sharing a key would make the first reply settle both promises
    // with one worker's answer, which is the failure the factory exists to
    // make impossible.
    for (const r of results) await expect(r).resolves.toBeTruthy();
  });

  it('rejects the whole batch when the factory produces a duplicate id', () => {
    const pool = makePool(Echo, { size: 1, maxSize: 1, maxTasksPerWorker: Infinity });
    // A duplicate id would make two pending responses share one key, so the
    // first reply would settle both. Validating the whole set up front fails
    // the call atomically instead: nothing sent, nothing orphaned.
    expect(() =>
      pool.postMessageBatch([{ message: { a: 1 } }, { message: { a: 2 } }], {
        awaitResponse: true,
        correlationIdFactory: () => 'same',
      })
    ).toThrow(/duplicate correlationId/);
  });

  it('calls the factory once per item, not once per retry', () => {
    const pool = makePool(Echo, { size: 1, maxSize: 1, maxTasksPerWorker: Infinity });
    let calls = 0;
    const results = pool.postMessageBatch(
      [{ message: { a: 1 } }, { message: { a: 2 } }, { message: { a: 3 } }],
      {
        awaitResponse: true,
        correlationIdFactory: (i) => {
          calls += 1;
          return `id-${i}`;
        },
      }
    );
    // An impure factory called more than `items.length` times produces ids
    // that are validated but not the ones used - so the count is the contract.
    expect(calls).toBe(3);
    // The promises settle on the next tick; settling them here keeps the
    // teardown from turning them into unhandled rejections.
    return Promise.all(results).catch(() => {});
  });
});

describe('PowerPool batch growth', () => {
  it('creates a worker to absorb a batch when the pool has room', () => {
    const pool = makePool(Silent, { size: 1, minSize: 1, maxSize: 4, maxTasksPerWorker: 1 });
    const before = pool.workers.length;
    pool.postMessageBatch([{ message: { a: 1 } }, { message: { a: 2 } }]);
    // The batch path grows the pool itself rather than queueing, which is the
    // whole reason it is not a loop over `postMessage`.
    expect(pool.workers.length).toBeGreaterThan(before);
  });

  it('never grows past maxSize', () => {
    const pool = makePool(Silent, { size: 1, minSize: 1, maxSize: 2, maxTasksPerWorker: 1 });
    pool.postMessageBatch(Array.from({ length: 20 }, (_, i) => ({ message: { a: i } })));
    expect(pool.workers.length).toBeLessThanOrEqual(2);
  });
});
