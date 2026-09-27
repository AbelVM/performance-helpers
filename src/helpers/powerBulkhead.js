/**
 * Partitioned executor for isolating noisy workloads from critical paths.
 *
 * Use `PowerBulkhead` to execute tasks in partitioned concurrency lanes so a
 * heavy or noisy partition cannot starve other partitions.
 */
import { PowerPermitGate } from './powerPermitGate.js';
import { PowerQueue } from './powerQueue.js';
import { DEFAULT_QUEUE_CAPACITY } from './constants.js';

/**
 * PowerBulkhead
 *
 * Partitioned executor that isolates noisy workloads into separate
 * concurrency partitions to avoid starving critical paths.
 *
 * @class PowerBulkhead
 * @public
 */
export class PowerBulkhead {
  /**
   * @param {Object} [options]
   * @param {number} [options.partitions=4] Number of isolated execution partitions.
   * @param {number} [options.maxConcurrency=1] Maximum concurrent tasks per partition.
   * @param {number} [options.queueCapacity=100] Maximum queued tasks across all partitions.
   * @param {Function} [options.partitioner] Function `(key)=>partitionIndex`.
   */
  constructor(options = {}) {
    const {
      partitions = 4,
      maxConcurrency = 1,
      queueCapacity = DEFAULT_QUEUE_CAPACITY,
      partitioner = null,
      onError = null,
    } = options || {};

    // `onError` is consulted whenever a user-supplied `release()`/task hook
    // throws. It was previously read via `this._onError?.()` but never
    // assigned, so those failures were silently discarded.
    this._onError = typeof onError === 'function' ? onError : null;

    this._partitions = Math.max(1, Math.floor(Number(partitions) || 4));
    this._maxConcurrency = Math.max(1, Math.floor(Number(maxConcurrency) || 1));
    this._queueCapacity = Math.max(0, Math.floor(Number(queueCapacity) || DEFAULT_QUEUE_CAPACITY));
    this._partitioner = typeof partitioner === 'function' ? partitioner : null;
    this._nextPartition = 0;
    this._pendingCount = 0;
    this._activeCount = 0;
    this._buckets = Array.from({ length: this._partitions }, () => ({
      gate: new PowerPermitGate({ capacity: this._maxConcurrency, queueCapacity: Infinity }),
    }));
    this._drainWaiters = new PowerQueue(16);
  }

  /** Number of partitions used for workload isolation. */
  get partitions() {
    return this._partitions;
  }

  /** Maximum concurrent tasks allowed per partition. */
  get maxConcurrency() {
    return this._maxConcurrency;
  }

  /** Total number of currently queued tasks. */
  get pending() {
    return this._pendingCount;
  }

  /** Total number of running tasks across all partitions. */
  get active() {
    return this._activeCount;
  }

  /** Maximum number of tasks that may wait in the queue. */
  get queueCapacity() {
    return this._queueCapacity;
  }

  /** True when the bulkhead queue is saturated. */
  get isFull() {
    return this.pending >= this._queueCapacity;
  }

  /**
   * Enqueue a task for execution under partition isolation.
   * @param {Function} task Async callback to execute.
   * @param {Object} [options]
   * @param {any} [options.partitionKey] Optional key used to route the task to a partition.
   * @returns {Promise<any>} Promise resolving or rejecting with task result.
   */
  run(task, options = {}) {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('PowerBulkhead.run() requires a function'));
    }

    const partition = this._choosePartition(options.partitionKey);
    const bucket = this._buckets[partition];
    const willQueue = bucket.gate.available === 0;
    if (this.pending >= this._queueCapacity && willQueue) {
      return Promise.reject(new Error('PowerBulkhead queue is full'));
    }

    if (willQueue) this._pendingCount += 1;
    else this._activeCount += 1;

    const permit = bucket.gate.acquire();
    const result = permit.then(
      (release) => {
        if (willQueue) {
          // A queued task promotes from the pending counter to the active one.
          this._pendingCount = Math.max(0, this._pendingCount - 1);
          this._activeCount += 1;
        }

        return Promise.resolve()
          .then(() => task())
          .finally(() => {
            try {
              release();
            } catch (e) {
              this._onError?.(e);
            }
            this._activeCount = Math.max(0, this._activeCount - 1);
            this._resolveDrainWaitersIfIdle();
          });
      },
      (err) => {
        // The permit was refused. The queued branch already decremented
        // `_pendingCount`; the non-queued branch had counted the task in
        // `_activeCount` when it was submitted, so that has to be unwound
        // here. Previously it was not, which permanently inflated
        // `_activeCount` and left `drain()` hanging forever.
        if (willQueue) {
          this._pendingCount = Math.max(0, this._pendingCount - 1);
        } else {
          this._activeCount = Math.max(0, this._activeCount - 1);
        }
        this._resolveDrainWaitersIfIdle();
        throw err;
      }
    );

    return result.finally(() => {
      this._resolveDrainWaitersIfIdle();
    });
  }

  /**
   * Try to execute immediately without queuing.
   * @param {Function} task
   * @param {Object} [options]
   * @param {any} [options.partitionKey]
   * @returns {Promise<any>|null}
   */
  tryRun(task, options = {}) {
    if (typeof task !== 'function') {
      throw new TypeError('PowerBulkhead.tryRun() requires a function');
    }
    const partition = this._choosePartition(options.partitionKey);
    const bucket = this._buckets[partition];
    const release = bucket.gate.tryAcquire();
    if (!release) return null;
    this._activeCount += 1;
    const result = Promise.resolve().then(() => task());
    return result.finally(() => {
      release();
      this._activeCount = Math.max(0, this._activeCount - 1);
      this._resolveDrainWaitersIfIdle();
    });
  }

  /**
   * Wait for all active and queued tasks to complete.
   * @returns {Promise<void>}
   */
  drain() {
    if (this.active === 0 && this.pending === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._drainWaiters.push(resolve);
    });
  }

  /**
   * Snapshot of the bulkhead's counters.
   * @returns {{active:number, pending:number, queueCapacity:number, partitions:number, maxConcurrency:number, saturated:boolean}}
   */
  stats() {
    return {
      active: this._activeCount,
      pending: this._pendingCount,
      queueCapacity: this._queueCapacity,
      partitions: this._partitions,
      maxConcurrency: this._maxConcurrency,
      saturated: this._pendingCount >= this._queueCapacity,
    };
  }

  /**
   * Reject every queued waiter across all partitions and return the bulkhead
   * to a fully idle state.
   *
   * `PowerBulkhead` was the only gate/queue/limit class in the library with no
   * disposal path, so a bulkhead that saturated (`queueCapacity` reached, all
   * permits held by tasks that never settle) could not be recovered: its
   * queued waiters were retained forever and `drain()` never resolved.
   *
   * Tasks that are already *running* are not cancelled - JavaScript cannot
   * interrupt them - but they no longer block a subsequent `drain()` from
   * resolving once they settle.
   *
   * @param {Object} [options] - Reset options.
   * @param {number} [options.available] - Permits to restore per partition.
   *   Defaults to `maxConcurrency`.
   * @param {string|Error} [options.reason] - Rejection reason for queued waiters.
   * @returns {void}
   */
  reset(options = {}) {
    const reason =
      options.reason instanceof Error
        ? options.reason
        : new Error(options.reason || 'PowerBulkhead reset');
    reason.code = reason.code || 'ERR_BULKHEAD_RESET';
    for (const bucket of this._buckets) {
      bucket.gate.reset({ available: this._maxConcurrency, reason });
    }
    this._pendingCount = 0;
    this._resolveDrainWaitersIfIdle();
  }

  /**
   * Alias for {@link PowerBulkhead#reset}.
   * @param {Object} [options] - Reset options.
   * @returns {void}
   */
  dispose(options) {
    this.reset(options);
  }

  [Symbol.dispose]() {
    this.reset();
  }

  _choosePartition(key) {
    if (this._partitioner) {
      const index = this._partitioner(key);
      return Math.abs(Number(index) || 0) % this._partitions;
    }
    if (key != null) {
      return this._hashKey(String(key)) % this._partitions;
    }
    const partition = this._nextPartition;
    this._nextPartition = (this._nextPartition + 1) % this._partitions;
    return partition;
  }

  _hashKey(value) {
    let hash = 5381;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash << 5) + hash + value.charCodeAt(i);
    }
    return hash >>> 0;
  }

  _resolveDrainWaitersIfIdle() {
    if (this._activeCount !== 0 || this._pendingCount !== 0) return;

    while (this._drainWaiters.length > 0) {
      const resolve = this._drainWaiters.shift();
      if (typeof resolve === 'function') {
        try {
          resolve();
        } catch (e) {
          /* ignore */
        }
      }
    }
  }
}

export default PowerBulkhead;
