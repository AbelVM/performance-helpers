import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * PISC-005: a worker readiness gate.
 *
 * Today a task can be dispatched to a worker still running async init — the worker
 * receives the message, cannot answer it, and the caller waits for a response that
 * will never come. The gate holds a worker out of dispatch until it signals ready.
 *
 * **The single-worker fast path is where this is easiest to get wrong**, and the
 * first draft got it wrong. `singleWorkerDirectFastPath` resolves `least` to
 * `this.workers[0]` directly, never reaching `_selectWorker()` — so with `size: 1`
 * the gate was bypassed entirely. Measured: a `size: 1` pool with `ready: true`
 * delivered the first post to a worker whose `ready` was still `false`. The
 * condition now carries `&& this._readyField == null`, which also keeps the fast
 * path free on the common path because that is the default.
 *
 * **The ready signal is matched on the *unwrapped* payload.** The first draft
 * checked `data` before the codec's decode block and matched nothing: the codec
 * wraps a payload as `{ version, codec, value, byteLength }`, so `data.ready` was
 * `undefined` for every real signal.
 */

/**
 * A worker fake that records what it was posted.
 *
 * The recording lives on the **underlying** native worker, which is what
 * `WorkerWrapper.postMessage` forwards to — reading `workerObj.sent` instead is
 * `undefined`, which is how two verification runs misread correct code as broken.
 */
function Recording() {
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  this.postMessage = (msg) => {
    this.sent = (this.sent || []).concat([msg]);
  };
  this.terminate = () => {};
}

/** How many messages the underlying worker received. */
const received = (pool, i = 0) => (pool.workers[i].worker._underlying.sent || []).length;

/** A single-worker pool, optionally gated. */
function makePool(options = {}) {
  return new PowerPool(Recording, {
    size: 1,
    minSize: 1,
    maxSize: 1,
    lazy: false,
    idleTimeout: 0,
    ...options,
  });
}

/** Post the ready signal from worker `i`'s underlying native worker. */
function signalReady(pool, i = 0) {
  pool.workers[i].worker._underlying.onmessage({ data: { ready: true } });
}

describe('PISC-005 the readiness gate', () => {
  it('holds a worker out of dispatch until it signals ready', () => {
    // The whole point, on the single-worker path where the first draft failed.
    const pool = makePool({ ready: true });
    expect(pool.workers[0].ready, 'not ready at construction').toBe(false);

    pool.postMessage({ n: 1 });
    expect(received(pool), 'the worker never received it').toBe(0);

    signalReady(pool);
    expect(pool.workers[0].ready).toBe(true);
    expect(received(pool), 'and the queued task dispatched').toBe(1);
  });

  it('is off by default, and the default path is unchanged', () => {
    // The gate must cost nothing when unused. Asserted on dispatch happening
    // immediately, which is what a stray `ready: false` would break.
    const pool = makePool();
    expect(pool.workers[0].ready, 'ready when there is no gate').toBe(true);
    pool.postMessage({ n: 1 });
    expect(received(pool)).toBe(1);
  });

  it('accepts a custom field name, so a worker can signal anything', () => {
    // The field is the caller's choice, because the worker's init protocol is the
    // caller's too.
    const pool = makePool({ ready: 'initialised' });
    expect(pool.workers[0].ready).toBe(false);
    pool.postMessage({ n: 1 });
    expect(received(pool)).toBe(0);

    pool.workers[0].worker._underlying.onmessage({ data: { initialised: true } });
    expect(pool.workers[0].ready).toBe(true);
    expect(received(pool)).toBe(1);
  });

  it('ignores extra fields on the signal, and a bare true', () => {
    // A worker posting `{ ready: true, version: 3 }` has signalled; one posting
    // `{ ready: false }` has not.
    const pool = makePool({ ready: true });
    pool.workers[0].worker._underlying.onmessage({ data: { ready: true, version: 3 } });
    expect(pool.workers[0].ready).toBe(true);

    const other = makePool({ ready: true });
    other.workers[0].worker._underlying.onmessage({ data: { ready: false } });
    expect(other.workers[0].ready, 'a falsy field is not a signal').toBe(false);

    const bare = makePool({ ready: true });
    bare.workers[0].worker._underlying.onmessage({ data: true });
    expect(bare.workers[0].ready, 'a bare true is a signal').toBe(true);
  });

  it('does not forward the signal to message listeners', () => {
    // Pool-internal protocol traffic, like the capability announcement. A caller
    // never sent it and would have to recognise it to be correct.
    const pool = makePool({ ready: true });
    const seen = [];
    pool.onmessage = (e) => seen.push(e.data);
    signalReady(pool);
    expect(seen, 'the signal was consumed, not forwarded').toHaveLength(0);
  });

  it('emits pool:worker:ready when a worker signals', () => {
    const pool = makePool({ ready: true });
    const seen = [];
    pool._bus.on('pool:worker:ready', (e) => seen.push(e));
    signalReady(pool);
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe(pool.workers[0].id);
  });

  it('fails open after readyTimeout, so a misbehaving worker cannot wedge the pool', () => {
    // A worker that never signals degrades to the old behaviour rather than
    // blocking dispatch forever. Applied lazily at dispatch, which is why the
    // second post is the one that goes through.
    vi.useFakeTimers();
    try {
      const pool = makePool({ ready: true, readyTimeout: 50 });
      pool.postMessage({ n: 1 });
      expect(received(pool), 'the gate holds immediately').toBe(0);

      vi.advanceTimersByTime(60);
      pool.postMessage({ n: 2 });
      expect(received(pool), 'and fails open once the bound passes').toBe(1);
      expect(pool.workers[0].ready).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses rather than round-robining past the gate when the queue is off', () => {
    // The round-robin fallback used to read `this.workers` directly, so a post that
    // reached it was round-robined straight to a worker still running async init.
    //
    // **`taskQueue: false` is what reaches this path.** With the queue on — the
    // default — the post is held in the queue instead and the fallback is never
    // reached, which is how the first draft of this test passed against the defect:
    // it asserted a refusal the pool never makes, on a path the pool never takes.
    const pool = makePool({ ready: true, maxSize: 2, taskQueue: false });
    pool.addWorker();
    expect(pool.workers).toHaveLength(2);
    expect(pool.workers.every((w) => !w.ready)).toBe(true);
    expect(pool.taskQueueEnabled, 'the queue is off, so the fallback is reachable').toBe(false);

    expect(pool.postMessage({ n: 1 }), 'fire-and-forget is refused').toBe(false);
    expect(received(pool, 0), 'and neither worker received it').toBe(0);
    expect(received(pool, 1)).toBe(0);
  });

  it('rejects an awaitResponse rather than leaving it to time out, queue off', async () => {
    // Same path, awaiting shape: the caller is told now rather than after
    // `awaitResponseTimeout`.
    const pool = makePool({ ready: true, maxSize: 2, taskQueue: false });
    pool.addWorker();
    await expect(pool.postMessage({ n: 1 }, undefined, { awaitResponse: true })).rejects.toThrow(
      /no worker is ready/
    );
  });

  it('queues rather than posting to a not-ready worker', () => {
    // The default shape, and the reason the two tests above need `taskQueue: false`:
    // with the queue on — the default — the work is held rather than lost, and the
    // caller is not told "no" for a condition that resolves in milliseconds.
    const pool = makePool({ ready: true, maxSize: 2 });
    pool.addWorker();
    expect(pool.workers).toHaveLength(2);
    expect(pool.workers.every((w) => !w.ready)).toBe(true);

    expect(pool.postMessage({ n: 1 }), 'accepted, not refused').toBe(true);
    expect(pool.queue.length, 'and held in the queue').toBe(1);
    expect(received(pool, 0)).toBe(0);
    expect(received(pool, 1)).toBe(0);

    // A worker becoming ready drains it.
    signalReady(pool, 0);
    expect(pool.queue.length).toBe(0);
    expect(received(pool, 0)).toBe(1);
  });

  it('keeps an awaitResponse pending until a worker is ready, rather than rejecting', async () => {
    // The caller waits rather than being refused, because the condition resolves in
    // milliseconds. Asserted on the promise still being pending — which is what a
    // gate that posted anyway, or one that rejected, would both break.
    const pool = makePool({ ready: true, maxSize: 2 });
    pool.addWorker();
    let settled = null;
    pool.postMessage({ n: 1 }, undefined, { awaitResponse: true, timeout: 5000 }).then(
      () => (settled = 'resolved'),
      () => (settled = 'rejected')
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(settled, 'still waiting, not refused').toBeNull();
    expect(pool.queue.length).toBe(1);

    signalReady(pool, 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(pool.queue.length, 'and dispatched once a worker is ready').toBe(0);
    expect(received(pool, 0)).toBe(1);
  });

  it('gates a multi-worker pool, dispatching only to the ready ones', () => {
    // The general case, so the fix is not pinned only on the single-worker path
    // where the defect lived.
    const pool = new PowerPool(Recording, {
      size: 2,
      minSize: 2,
      maxSize: 2,
      lazy: false,
      idleTimeout: 0,
      ready: true,
    });
    expect(pool._readyWorkers(), 'neither is ready').toHaveLength(0);

    signalReady(pool, 1);
    expect(pool._readyWorkers(), 'only the one that signalled').toHaveLength(1);
    pool.postMessage({ n: 1 });
    expect(received(pool, 1), 'dispatched to the ready worker').toBe(1);
    expect(received(pool, 0), 'and not to the other').toBe(0);
  });

  it('allocates nothing for the ready set when there is no gate', () => {
    // `_readyWorkers()` returns `this.workers` itself rather than a copy, so the
    // default path pays no allocation. Pinned by identity, not by a duration.
    const pool = makePool();
    expect(pool._readyWorkers()).toBe(pool.workers);
  });
});
