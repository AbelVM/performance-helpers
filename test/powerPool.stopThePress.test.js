import { describe, it, expect, afterEach } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * POOL-003: `stopThePress` enqueued a message the caller handed it directly,
 * bypassing `_prepareForTransfer`.
 *
 * **One half of the row reproduces and one does not, and the difference matters.**
 * The row claims the message goes on the wire unframed. It does not: the drain
 * calls `_encodeForWorker` on whatever it dequeues, which frames it. What *is*
 * demonstrable is the other half — `deferred` is dropped, which under
 * `messageCodec: 'negotiated'` means the per-worker carrier decision is bypassed.
 * So the row's `[verified]` framing is right about the cause and wrong about the
 * visible symptom, and the test below asserts the part that is real.
 *
 * The assertion is on the **shape of the queued item**, comparing the two
 * enqueue routes against each other rather than against a hard-coded expectation.
 * That is deliberate: "an item in the queue is a `PreparedItem`" is a property of
 * the contract, and two paths disagreeing about it is exactly what regressed.
 */

/** Accepts work and never answers, so a slot can be held open deterministically. */
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

/**
 * A pool with its single slot already occupied, so a further `postMessage`
 * queues rather than dispatching.
 *
 * The occupying post is **not awaited**: a silent worker never answers, so
 * awaiting it hangs forever. Three earlier attempts at this file were lost to
 * exactly that, and to `pool.workers[0].worker` not being this object.
 *
 * @param {string} messageCodec
 * @returns {PowerPool}
 */
function poolWithFullQueue(messageCodec) {
  last = null;
  const pool = new PowerPool(Silent, {
    size: 1,
    minSize: 1,
    maxSize: 1,
    lazy: false,
    maxTasksPerWorker: 1,
    queuePolicy: 'queue',
    awaitResponseTimeout: 0,
    messageCodec,
  });
  pools.push(pool);
  pool.worker = last;
  pool.occupying = pool
    .postMessage({ occupying: true }, undefined, { awaitResponse: true, correlationId: 'busy' })
    .catch(() => {});
  return pool;
}

/**
 * A `postMessage` whose task is later discarded or whose worker is terminated
 * rejects. This test discards tasks and terminates workers on purpose, so every
 * result is handled here — an unhandled rejection is invisible in the test count
 * and shows up only in vitest's error summary, which is how the `POOL-002` file's
 * first draft shipped two errors while reporting "1625 passed".
 *
 * @param {*} result - Whatever `postMessage` returned.
 * @returns {void}
 */
function ignore(result) {
  if (result && typeof result.then === 'function') result.then(undefined, () => {});
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

describe('stopThePress prepares its message like every other enqueue route (POOL-003)', () => {
  it('marks the item deferred under negotiated, as postMessage does', () => {
    // The demonstrable half of the row. Under `'negotiated'` the carrier is a
    // per-worker decision, so an item without `deferred` gets encoded for a
    // worker that may not have asked for that codec.
    const viaPost = poolWithFullQueue('negotiated');
    ignore(viaPost.postMessage({ route: 'postMessage' }, undefined, { correlationId: 'pm' }));
    const fromPostMessage = viaPost.queue.peek();

    const viaStop = poolWithFullQueue('negotiated');
    viaStop.stopThePress({ route: 'stopThePress' }, undefined, { recreateWorkers: false });
    const fromStopThePress = viaStop.queue.peek();

    expect(fromPostMessage.deferred).toBe(true);
    expect(
      fromStopThePress.deferred,
      'stopThePress enqueued the caller`s object directly, so the drain cannot ' +
        'resolve the per-worker carrier — the whole point of the deferred marker'
    ).toBe(true);
  });

  it('agrees with postMessage on the queued item under every codec', () => {
    // The property rather than one codec's expectation: the two routes must not
    // disagree about what an item in the queue is.
    for (const codec of ['negotiated', 'framed', 'legacy']) {
      const viaPost = poolWithFullQueue(codec);
      ignore(viaPost.postMessage({ route: 'postMessage' }, undefined, { correlationId: 'pm' }));
      const fromPostMessage = { ...viaPost.queue.peek() };
      delete fromPostMessage.correlationId;

      const viaStop = poolWithFullQueue(codec);
      viaStop.stopThePress({ route: 'stopThePress' }, undefined, { recreateWorkers: false });
      const fromStopThePress = { ...viaStop.queue.peek() };

      expect(
        Object.keys(fromStopThePress).sort(),
        `queued item keys differ under ${codec}`
      ).toEqual(Object.keys(fromPostMessage).sort());
      expect(fromStopThePress.deferred, `deferred differs under ${codec}`).toBe(
        fromPostMessage.deferred
      );
    }
  });

  it('still drains the queue and reports the enqueue result, unchanged', () => {
    // `stopThePress` empties the queue by design, so a refusal is not reachable
    // here and an earlier version of this test asserted one — against a premise
    // the method's own contract contradicts. What is worth pinning is that the
    // inserted `_prepareForTransfer` call did not change the return value: it is
    // documented as `postMessage` semantics, and a call that threw before the
    // enqueue would turn a refusal into a success or vice versa.
    const pool = poolWithFullQueue('negotiated');
    ignore(pool.postMessage({ discarded: true }, undefined, { correlationId: 'stale' }));
    expect(pool.queue.length).toBe(1);

    const result = pool.stopThePress({ kept: true }, undefined, { recreateWorkers: false });
    expect(result).toBe(true);
    // The stale entry is gone and the new one is there, deferred.
    const remaining = pool.queue.peek();
    expect(remaining.deferred).toBe(true);
    expect(pool.queue.length).toBe(1);
  });

  it('still forwards the message on the recreate path, framed', () => {
    // The other half of `stopThePress`: with workers recreated, the message is
    // dispatched rather than enqueued, and it must reach the worker as a frame.
    // A `PreparedItem` is what guarantees that, so this is the same fix observed
    // on the dispatch side.
    const pool = poolWithFullQueue('framed');
    pool.stopThePress({ alarm: true }, undefined, { recreateWorkers: true });
    // `recreateWorkers: true` terminates the old worker and builds a new one, so
    // the instance captured at construction is stale — `last` is the newest.
    const recreated = last;

    const framed = recreated.posted.find((e) => {
      const m = e.msg;
      return m instanceof Uint8Array && m[0] === 1;
    });
    expect(framed, 'the forwarded message did not reach the worker as a frame').toBeDefined();
  });
});
