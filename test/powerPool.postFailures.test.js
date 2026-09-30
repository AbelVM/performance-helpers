/**
 * POOL-005: a batched post that failed was a `false` in an array and nothing else.
 *
 * `postMessageBatch` answers with a per-item boolean. Three sites can set one to
 * `false`, and **two of them caught the error and discarded it** — no log, no
 * `pool:error` event, no counter. The third already logged and emitted, which is
 * what made the omission visible.
 *
 * The consequence is a caller who cannot distinguish a dispatch failure from a
 * busy worker, and an operator with no signal that a batch silently lost items.
 * A batch is the case where this matters most: one `postMessage` failing is a
 * returned `false` a caller can check, but a batch of a thousand returns an array
 * where a handful of entries are quietly wrong.
 *
 * Every assertion is a counter, an event, or a return value. There is no timing
 * and nothing depends on how a failure is provoked.
 */
import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * A worker whose `postMessage` throws on the nth call, so each failure site is
 * reachable without racing anything.
 *
 * Note on the two internals reached for below: `pool._bus` and `pool._logger`
 * have **no public accessors**, and the logger is not settable through an
 * option. Both are reached directly, which this repository's tests do
 * elsewhere; the alternative was a test that asserted on a `vi.fn()` the pool
 * never received.
 * @param {{throwsOn?: number}} [opts]
 */
function makeWorkerFactory({ throwsOn = 1 } = {}) {
  let calls = 0;
  const state = { posted: 0, failed: false };
  function FakeWorker() {
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.tasks = 0;
    this.completedTasks = 0;
    this.id = 'w1';
    this.posted = [];
    this.postMessage = (msg, transfer) => {
      // Per **call**, not per construction. The first version captured the count
      // at construction, so with `size: 1` every post to the one worker instance
      // matched and all three items came back `false` — the opposite of the
      // "counts only the items that failed" case it was meant to demonstrate.
      calls += 1;
      if (calls === throwsOn) {
        state.failed = true;
        throw new Error('postMessage exploded');
      }
      this.posted.push(transfer ? { msg, transfer } : { msg });
      state.posted += 1;
    };
    this.terminate = () => {};
    this.postMessageToWorker = this.postMessage;
  }
  return { FakeWorker, state };
}

/** @returns {PowerPool} */
function makePool(workerSource, options = {}) {
  return new PowerPool(workerSource, { size: 1, minSize: 1, maxSize: 1, lazy: false, ...options });
}

describe('POOL-005: a failed batched post is reported, not swallowed', () => {
  it('counts a single-worker batch dispatch failure', () => {
    const { FakeWorker } = makeWorkerFactory({ throwsOn: 1 });
    const pool = makePool(FakeWorker);
    try {
      const results = pool.postMessageBatch([{ message: { a: 1 } }]);
      // The contract is unchanged: a per-item boolean.
      expect(results).toEqual([false]);
      // And it is now also counted, which it was not before.
      expect(pool.getStats().postFailures).toBe(1);
    } finally {
      pool.terminate();
    }
  });

  it('emits pool:error for a batch failure', () => {
    const { FakeWorker } = makeWorkerFactory({ throwsOn: 1 });
    const pool = makePool(FakeWorker);
    const onError = vi.fn();
    try {
      pool._bus.on('pool:error', onError);
      pool.postMessageBatch([{ message: { a: 1 } }]);
      expect(onError).toHaveBeenCalledTimes(1);
      // The event names the phase, so a listener can attribute it.
      expect(onError.mock.calls[0][0]).toMatchObject({ phase: 'postMessageBatch' });
      // And it carries the error, not just a flag — the whole point of logging
      // is that a caller can see *why*.
      expect(onError.mock.calls[0][0].error).toBeInstanceOf(Error);
    } finally {
      pool.terminate();
    }
  });

  it('logs the failure', () => {
    const { FakeWorker } = makeWorkerFactory({ throwsOn: 1 });
    const error = vi.fn();
    const pool = makePool(FakeWorker);
    // The logger is constructed internally (`this._logger = new PowerLogger(...)`)
    // and there is **no `logger` option** — a first version of this test passed
    // one and the pool ignored it, so the assertion below read a `vi.fn()` that
    // was never called and the test failed for the wrong reason.
    pool._logger = { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    try {
      pool.postMessageBatch([{ message: { a: 1 } }]);
      expect(error).toHaveBeenCalled();
      expect(error.mock.calls[0][0]).toBeInstanceOf(Error);
    } finally {
      pool.terminate();
    }
  });

  it('counts only the items that failed, not the whole batch', () => {
    // The distinction that makes the count useful. A batch where the first item
    // throws and the rest succeed must report one failure, not three — so an
    // operator can tell "one bad item" from "the transport is broken".
    const { FakeWorker } = makeWorkerFactory({ throwsOn: 1 });
    const pool = makePool(FakeWorker);
    try {
      const results = pool.postMessageBatch([
        { message: { a: 1 } },
        { message: { b: 2 } },
        { message: { c: 3 } },
      ]);
      expect(results).toEqual([false, true, true]);
      expect(pool.getStats().postFailures).toBe(1);
    } finally {
      pool.terminate();
    }
  });

  it('reports nothing and counts nothing for a clean batch', () => {
    // The counterpart, and the reason the previous tests are not just "something
    // always fires". A gate that counted every batch would be noise.
    const { FakeWorker } = makeWorkerFactory({ throwsOn: -1 });
    const pool = makePool(FakeWorker);
    const onError = vi.fn();
    try {
      pool._bus.on('pool:error', onError);
      const results = pool.postMessageBatch([{ message: { a: 1 } }, { message: { b: 2 } }]);
      expect(results).toEqual([true, true]);
      expect(onError).not.toHaveBeenCalled();
      expect(pool.getStats().postFailures).toBe(0);
    } finally {
      pool.terminate();
    }
  });

  it('keeps reporting when the logger itself throws', () => {
    // The case that justifies the individual guards. This runs inside a `catch`,
    // so a logger that throws would otherwise *replace* the original failure and
    // the item would be neither sent nor reported.
    const { FakeWorker } = makeWorkerFactory({ throwsOn: 1 });
    const pool = makePool(FakeWorker);
    pool._logger = {
      error() {
        throw new Error('logger is broken too');
      },
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    const onError = vi.fn();
    try {
      pool._bus.on('pool:error', onError);
      const results = pool.postMessageBatch([{ message: { a: 1 } }]);
      expect(results).toEqual([false]);
      // The count and the event still happened.
      expect(pool.getStats().postFailures).toBe(1);
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      pool.terminate();
    }
  });
});
