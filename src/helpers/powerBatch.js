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
import { PowerScheduler } from './powerScheduler.js';

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
   */
  /**
   * @param {Function} handler - Function called with an array of collected items.
   * @param {Object} [options]
   * @param {number} [options.maxSize=Infinity] - When reached, flush immediately.
   * @param {'microtask'|'macrotask'} [options.scheduling='microtask'] - How the batch is scheduled.
   */
  constructor(handler, options = {}) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    const { maxSize = Infinity, scheduling = 'microtask' } = options;
    this._handler = handler;
    this._maxSize = Number(maxSize) || Infinity;
    this._queue = new PowerQueue(16);
    this._pending = null; // { promise, resolve, reject }
    this._scheduler = new PowerScheduler(() => this._runBatch(), {
      scheduling: scheduling === 'macrotask' ? 'macrotask' : 'microtask',
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
    if (!this._pending) {
      let resolve, reject;
      const p = new Promise((r, rej) => {
        resolve = r;
        reject = rej;
      });
      this._pending = { promise: p, resolve, reject };
    }
    if (this._queue.length >= this._maxSize) {
      const prom = this._pending.promise;
      this._scheduler.cancel();
      this._runBatch();
      return prom;
    }

    if (!this._scheduler.scheduled) {
      this._scheduler.schedule();
    }
    return this._pending.promise;
  }

  /**
   * Force flush the current queue immediately and return a promise
   * that resolves or rejects with the handler outcome.
   * If the queue is empty and nothing is scheduled, the returned promise
   * resolves immediately.
   * @returns {Promise<void>}
   */
  flush() {
    if (this._queue.length === 0 && !this._scheduler.scheduled) return Promise.resolve();
    if (!this._pending) {
      let resolve, reject;
      const p = new Promise((r, rej) => {
        resolve = r;
        reject = rej;
      });
      this._pending = { promise: p, resolve, reject };
    }
    if (!this._scheduler.scheduled) {
      this._scheduler.schedule();
    }
    return this._pending.promise;
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
  clear() {
    this._queue.clear();
    if (this._pending) {
      this._pending.reject(new Error('PowerBatch cleared before flush'));
      this._pending = null;
    }
    this._scheduler.cancel();
  }
}

export default PowerBatch;
