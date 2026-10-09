/**
 * PowerBatch — scheduler-driven dispatcher.
 * Collects items added before the next scheduled tick and dispatches them
 * to the provided `handler(items[])`. Useful to batch synchronous work
 * (DB writes, network calls) with minimal latency.
 *
 * The scheduler defaults to microtask coalescing, but `scheduling: 'macrotask'`
 * is also supported for environments that require a macrotask boundary.
 *
 * @example
 * const batch = new PowerBatch((items) => bulkWrite(items), { maxSize: 100 });
 * batch.add(itemA);
 * batch.add(itemB);
 * // items are coalesced and handler called once in the next tick
 */
import { PowerQueue } from './powerQueue.js';
import { abortReason, raceWithAbort } from '../utils/abort.js';
import { assertLimitRequired, assertKnownOptions } from '../utils/options.js';
import { PowerScheduler } from './powerScheduler.js';
import { POWER_QUEUE_INITIAL_CAPACITY } from './constants.js';
import { neutralise } from '../utils/neutralise.js';

/**
 * PowerBatch
 *
 * Scheduler-driven batching helper that collects items and dispatches them
 * to a provided handler on a microtask/macrotask boundary.
 *
 * @class PowerBatch
 * @public
 */
export class PowerBatch {
  /**
   * @typedef {import('./jsdoc-types.js').PowerBatchOptions} PowerBatchOptions
   * @typedef {import('./jsdoc-types.js').BatchPending} BatchPending
   */
  /**
   * @param {(items:any[])=>Promise<void>|void} handler - Called with the whole
   *   collected array each time the batch flushes. A rejection rejects every
   *   promise handed out by `add()`/`flush()` in that batch.
   * @param {PowerBatchOptions} [options] - `maxSize` defaults to unbounded and
   *   `scheduling` to `'microtask'`.
   */
  constructor(handler, options = {}) {
    assertKnownOptions(options, ['maxSize', 'scheduling', 'onError'], 'PowerBatch');
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    const { maxSize = Number.POSITIVE_INFINITY, scheduling = 'microtask' } = options;
    const onError = typeof options.onError === 'function' ? options.onError : undefined;
    this._handler = handler;
    // `Number(maxSize) || Infinity` turned `maxSize: 0` into `Infinity` - a
    // batch that then never flushes, silently. Validate instead.
    this._maxSize = assertLimitRequired(maxSize, {
      name: 'maxSize',
      className: 'PowerBatch',
      integer: true,
      min: 1,
      allowInfinity: true,
    });
    this._queue = new PowerQueue(POWER_QUEUE_INITIAL_CAPACITY);
    /** @type {?BatchPending} */
    this._pending = null;
    // **Passed through, not coerced.** This was
    // `scheduling === 'macrotask' ? 'macrotask' : 'microtask'`, which silently
    // turned `'typo'` into `'microtask'` — defeating the explicit throw
    // `PowerScheduler` performs for exactly that case, whose own comment says "a
    // typo would otherwise silently pick the *fastest* strategy for a scheduler
    // that was asked for something else". It also lost the `'yield'` strategy
    // entirely, even though `PowerScheduler` supports it and prioritises it.
    //
    // The default above is what supplies `'microtask'`, so an omitted option
    // behaves exactly as before and a caller who asked for something specific
    // now gets it — or a `TypeError` naming what is valid.
    this._scheduler = new PowerScheduler(() => this._runBatch(), {
      scheduling,
      // Without this, `_runBatch`'s `else throw err` — reached when the handler
      // rejects and there is no pending promise to reject, i.e. during a
      // scheduler-driven flush rather than an `add()`-triggered one — became a
      // silent unhandled rejection that nothing in this class could observe.
      onError,
    });
  }

  /**
   * Add an item to the current batch. Returns a Promise that resolves
   * when the batch containing this item has been processed. For non-flushed
   * additions this will be resolved after the scheduled run; if adding the
   * item hits `maxSize` the returned promise resolves when the handler completes.
   * @param {any} item
   * @returns {Promise<void>}
   */
  add(item) {
    this._queue.push(item);
    const pending = this._ensurePending();
    if (this._queue.length >= this._maxSize) {
      const prom = pending.promise;
      this._scheduler.cancel();
      this._runBatch();
      return prom;
    }

    if (!this._scheduler.scheduled) {
      this._scheduler.schedule();
    }
    return pending.promise;
  }

  /**
   * Force flush the current queue immediately and return a promise
   * that resolves or rejects with the handler outcome.
   * If the queue is empty and nothing is scheduled, the returned promise
   * resolves immediately.
   * @param {{signal?: AbortSignal}} [options] `signal` abandons this caller's
   *   *wait* for the flush, not the flush itself — queued items still belong to
   *   the callers who passed them to `add()`, so the shared pending promise is
   *   deliberately left to settle.
   * @returns {Promise<void>}
   */
  flush(options = {}) {
    const signal = /** @type {{signal?: AbortSignal}} */ (options)?.signal ?? null;
    // Aborting the flush abandons the *wait*, not the flush. The queued items
    // still belong to the callers who passed them to `add()`, and rejecting the
    // shared pending promise would break those; only this caller's view of the
    // completion is dropped.
    if (this._queue.length === 0 && !this._scheduler.scheduled) {
      return signal?.aborted ? Promise.reject(abortReason(signal)) : Promise.resolve();
    }
    const pending = this._ensurePending();
    if (!this._scheduler.scheduled) {
      this._scheduler.schedule();
    }
    return raceWithAbort(pending.promise, signal);
  }

  /**
   * The pending entry for the batch being assembled, created on first use.
   *
   * Extracted because `add()` and `flush()` both needed it, and duplicating the
   * `let resolve, reject` dance meant the uninitialised `undefined` was
   * assignable to the handles at one site and not the other.
   *
   * @returns {BatchPending}
   */
  _ensurePending() {
    if (this._pending) return this._pending;
    /** @type {(value?: any) => void} */
    let resolve = () => {};
    /** @type {(reason?: any) => void} */
    let reject = () => {};
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    /** @type {BatchPending} */
    const pending = { promise, resolve, reject };
    this._pending = pending;
    return pending;
  }

  /**
   * Internal: run the queued batch and call the handler.
   * @private
   */
  async _runBatch() {
    const size = this._queue.length;
    if (size === 0) {
      if (this._pending) {
        this._pending.resolve();
        this._pending = null;
      }
      return;
    }

    // Pre-size the batch array and drain queue in one pass.
    const items = new Array(size);
    let idx = 0;
    for (const item of this._queue.drain()) {
      items[idx++] = item;
    }

    const pending = this._pending;
    // create a fresh pending for subsequent adds during handler execution
    if (pending) this._pending = null;

    try {
      await this._handler(items);
      if (pending) pending.resolve();
    } catch (err) {
      if (pending) pending.reject(err);
      else throw err;
    }
  }

  /**
   * Number of items currently queued (not yet flushed).
   * @returns {number}
   */
  get size() {
    return this._queue.length;
  }

  /**
   * Clear queued items without invoking handler.
   * Any pending promise for the current batch is rejected.
   * @returns {void}
   */

  /**
   * Alias for {@link PowerBatch#clear}.
   *
   * `clear()` here empties the container, and "reset" is a natural second word
   * for exactly that - so a caller who reaches for `reset()` on this class gets
   * the obvious thing instead of a `TypeError`. No limiter gets this alias: for
   * `PowerThrottle` and `PowerPermitGate`, `reset()` *refills* and `clear()`
   * would read as the opposite, and the two are deliberately not synonyms.
   *
   * @returns {void}
   */
  reset() {
    this.clear();
  }

  clear() {
    this._queue.clear();
    if (this._pending) {
      this._pending.reject(new Error('PowerBatch cleared before flush'));
      this._pending = null;
    }
    this._scheduler.cancel();
  }

  /**
   * Release every resource this instance holds.
   *
   * Idempotent, and safe to call while the instance is idle. Exists so the
   * instance works with `using` / `await using` and gives callers an explicit
   * name to call.
   *
   * @returns {void}
   */
  dispose() {
    this.clear();
    // Neutralise the cleanup so a second dispose (or a late call) is a no-op
    // rather than a second teardown pass.
    neutralise(this, 'clear');
  }

  /**
   * Alias for {@link dispose}, so `using x = new X()` releases the instance
   * deterministically at scope exit.
   * @returns {void}
   */
  [Symbol.dispose]() {
    this.dispose();
  }

  /**
   * Asynchronous disposal hook (thin wrapper). Forwards to sync disposal.
   * @returns {Promise<void>}
   */
  async [Symbol.asyncDispose]() {
    this.dispose();
    return;
  }
}

export default PowerBatch;
