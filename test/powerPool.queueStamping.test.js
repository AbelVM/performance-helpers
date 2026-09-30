import { describe, it, expect, afterEach } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * POOL-002: a task queued and then dispatched by the inline drain inside
 * `worker.onmessage` was never associated with the worker that took it.
 *
 * The consequence is the worst this class produces: the caller's promise **never
 * settles**. With `awaitResponseTimeout: Infinity` there is no timer to save it,
 * so when the worker is terminated `_rejectPendingForWorker` walks the pending map
 * for entries whose `workerId` matches, finds none — because nothing set it — and
 * the promise hangs for good. Meanwhile the drain had already counted the task on
 * the worker (`tasks++`, `_activeTasks++`), so the pool's own state claimed the
 * work was outstanding. BUG-011 is not closed until this is.
 *
 * Three harness facts this took two attempts to establish, each of which makes the
 * defect *unreachable* rather than absent — a test that cannot fail on the
 * regression is decoration, and here the regression is easy to write a passing
 * test about:
 *
 * 1. **Both `postMessage` calls must be in flight together**, with no `await`
 *    between them. Awaiting the first lets `tasks` fall back to 0, so the second
 *    is dispatched directly and `queue` stays at 0 — the drain never runs.
 * 2. **The worker must never answer.** A worker that echoes the frame settles the
 *    promise by another route, so the hang cannot be shown with one.
 * 3. **The response event has to be driven by hand** as the frame the worker
 *    actually received, because that is what the pool decodes to find the
 *    correlation id.
 *
 * The assertion is on the *association* and on whether the promise settles at
 * all. "It hangs forever" is not something a duration can honestly demonstrate — a
 * test that waits N ms and asserts "still pending" passes on a slow machine and
 * fails on a fast one.
 */

/**
 * Accepts work, records it, and never answers.
 *
 * The instance is captured in a module-level `last` rather than reached for
 * through `pool.workers[0].worker`, which is not the same object. The first draft
 * did use that path and threw `Cannot read properties of undefined (reading '0')`
 * on every case — a broken assertion wearing a broken pool's clothes.
 */
let last = null;
function Silent() {
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  this.posted = [];
  last = this;
  this.postMessage = (msg, transfer) => {
    this.posted.push(transfer ? { msg, transfer } : { msg });
  };
  this.terminate = () => {};
}

const pools = [];
function makePool(options = {}) {
  last = null;
  const pool = new PowerPool(Silent, {
    size: 1,
    minSize: 1,
    maxSize: 1,
    lazy: false,
    // One task in flight at a time, so the second `postMessage` must queue —
    // the only route to the inline drain.
    maxTasksPerWorker: 1,
    queuePolicy: 'queue',
    awaitResponseTimeout: Infinity,
    ...options,
  });
  pools.push(pool);
  pool.worker = last;
  return pool;
}

/**
 * The first task's response event, as the pool's own `onmessage` would see it.
 *
 * @param {import('../src/helpers/powerPool.js').PowerPool} pool
 */
function deliverFirstResponse(pool) {
  pool.worker.onmessage({ data: pool.worker.posted[0].msg });
}

/**
 * Keep a promise from becoming an unhandled rejection.
 *
 * `void promise` discards the *reference*; it does not attach a handler, so a
 * promise that rejects during `terminate()` is reported as an unhandled
 * rejection. The first draft of this file did exactly that and the suite came
 * back "1625 passed" with 2 errors — the failure was invisible in the test count
 * and only visible in vitest's error summary, which is easy to miss and would
 * have shipped.
 *
 * @param {Promise<*>} promise
 * @returns {void}
 */
function ignore(promise) {
  promise.catch(() => {});
}

/** @param {Promise<*>} promise */
function settledWithin(promise, ms) {
  return Promise.race([
    promise.then(
      () => 'resolved',
      () => 'rejected'
    ),
    // A sentinel, not a duration assertion: the claim is that the promise settles
    // *at all*, and the pool's own teardown is what must cause it.
    new Promise((resolve) => setTimeout(() => resolve('STILL PENDING'), ms)),
  ]);
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

describe('a task dispatched by the inline drain records its worker (POOL-002)', () => {
  it('marks the pending response with the worker that took it', async () => {
    const pool = makePool();

    // Both in flight together — see harness fact 1.
    const first = pool.postMessage({ n: 1 }, undefined, {
      awaitResponse: true,
      correlationId: 'a',
    });
    const second = pool.postMessage({ n: 2 }, undefined, {
      awaitResponse: true,
      correlationId: 'b',
    });
    expect(pool.queue.length, 'the second task did not queue, so the drain is unreachable').toBe(1);
    expect(pool._pendingResponses.get('b').workerId).toBeUndefined();
    // The direct path already marked `a`, which is why the defect is specific to
    // the queued-then-inlined route. Asserted here rather than after the
    // response, because that response *settles* `a` and deletes its entry.
    expect(pool._pendingResponses.get('a').workerId).toBe(pool.workers[0].id);

    deliverFirstResponse(pool);

    expect(pool.worker.posted).toHaveLength(2);
    expect(
      pool._pendingResponses.get('b').workerId,
      'the inline drain dispatched the task without recording its worker, so ' +
        '_rejectPendingForWorker can never match it and the promise hangs forever'
    ).toBe(pool.workers[0].id);

    ignore(first);
    ignore(second);
  });

  it('settles the queued promise on terminate rather than leaving it pending', async () => {
    const pool = makePool();
    const first = pool.postMessage({ n: 1 }, undefined, {
      awaitResponse: true,
      correlationId: 'a',
    });
    const second = pool.postMessage({ n: 2 }, undefined, {
      awaitResponse: true,
      correlationId: 'b',
    });
    deliverFirstResponse(pool);
    expect(pool._pendingResponses.get('b').workerId).toBe(pool.workers[0].id);

    // Before termination, nothing has answered `b`, so it is genuinely outstanding.
    expect(await settledWithin(second, 50)).toBe('STILL PENDING');

    // Termination is the only thing that can settle it, and it now does.
    const settled = settledWithin(second, 500);
    pool.terminate();
    expect(await settled).toBe('rejected');

    ignore(first);
  });

  it('leaves the direct path unchanged, which already marked correctly', async () => {
    // Not decoration: the two routes are the whole reason this was a one-line
    // fix rather than a design change, and a test that only covered the broken
    // route would not show the fix was additive.
    const pool = makePool({ maxTasksPerWorker: Infinity });
    const only = pool.postMessage({ n: 1 }, undefined, {
      awaitResponse: true,
      correlationId: 'solo',
    });
    expect(pool._pendingResponses.get('solo').workerId).toBe(pool.workers[0].id);
    ignore(only);
  });
});
