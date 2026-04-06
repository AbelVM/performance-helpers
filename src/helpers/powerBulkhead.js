/**
 * Partitioned executor for isolating noisy workloads from critical paths.
 *
 * Use `PowerBulkhead` to execute tasks in partitioned concurrency lanes so a
 * heavy or noisy partition cannot starve other partitions.
 */
import { PowerPermitGate } from './powerPermitGate.js';
import { PowerQueue } from './powerQueue.js';

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
      queueCapacity = 100,
      partitioner = null,
    } = options || {};

    this._partitions = Math.max(1, Math.floor(Number(partitions) || 4));
    this._maxConcurrency = Math.max(1, Math.floor(Number(maxConcurrency) || 1));
    this._queueCapacity = Math.max(0, Math.floor(Number(queueCapacity) || 100));
    this._partitioner = typeof partitioner === 'function' ? partitioner : null;
    this._nextPartition = 0;
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
    return this._buckets.reduce((sum, bucket) => sum + bucket.gate.pending, 0);
  }

  /** Total number of running tasks across all partitions. */
  get active() {
    return this._buckets.reduce((sum, bucket) => sum + bucket.gate.active, 0);
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
    if (this.pending >= this._queueCapacity && bucket.gate.available === 0) {
      return Promise.reject(new Error('PowerBulkhead queue is full'));
    }

    const permit = bucket.gate.acquire();
    const result = permit.then((release) => {
      return Promise.resolve()
        .then(() => task())
        .finally(() => release());
    });

    return result.finally(() => {
      if (this.active === 0 && this.pending === 0) {
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
    const result = Promise.resolve().then(() => task());
    return result.finally(() => release());
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
}

export default PowerBulkhead;
