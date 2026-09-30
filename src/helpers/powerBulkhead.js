/**
 * Partitioned executor for isolating noisy workloads from critical paths.
 *
 * Use `PowerBulkhead` to execute tasks in partitioned concurrency lanes so a
 * heavy or noisy partition cannot starve other partitions.
 */
import { assertLimitRequired } from '../utils/options.js';
import { PowerPermitGate } from './powerPermitGate.js';
import { PowerQueue } from './powerQueue.js';
import { DEFAULT_QUEUE_CAPACITY, POWER_QUEUE_INITIAL_CAPACITY } from './constants.js';
import { attach, detach } from './metrics.js';

/**
 * PowerBulkhead
 *
 * Partitioned executor that isolates noisy workloads into separate
 * concurrency partitions to avoid starving critical paths.
 *
 * @class PowerBulkhead
 * @public
 */
/**
 * @typedef {import('./jsdoc-types.js').PowerBulkheadOptions} PowerBulkheadOptions
 * @typedef {import('./jsdoc-types.js').PowerBulkheadResetOptions} PowerBulkheadResetOptions
 * @typedef {import('./jsdoc-types.js').BulkheadResetError} BulkheadResetError
 */
export class PowerBulkhead {
  /**
   * @param {PowerBulkheadOptions} [options]
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

    // All three are limits, and each was coerced into a plausible-looking number
    // rather than reporting a bad configuration:
    //
    //   partitions: 0        -> Math.max(1, 0 || 4)     = 4
    //   maxConcurrency: 0    -> Math.max(1, 0 || 1)     = 1
    //   queueCapacity: 0     -> Math.max(0, 0 || 100)   = 100
    //
    // The first two are the same mistake `PowerPermitGate.capacity` already
    // stopped making: a bulkhead configured to allow nothing is how you switch a
    // dependency off, and `0` silently became 1 - the exact opposite of the
    // stated intent. The third is the more surprising one, because it is the
    // *opposite* error: `PowerPermitGate` documents `queueCapacity: 0` as a
    // legal request ("refuse immediately instead of queueing"), and this
    // silently turned that request into the full default queue. A value that
    // reads as "no queue" and produces the largest queue the class supports is
    // not a coercion, it is a contradiction.
    //
    // So: `partitions` and `maxConcurrency` are `>= 1` and throw; `queueCapacity`
    // is `>= 0` and **0 is honoured**, because a queue that refuses to hold
    // anything is a real configuration, not a mistake.
    this._partitions = assertLimitRequired(partitions, {
      name: 'partitions',
      className: 'PowerBulkhead',
      min: 1,
      fallback: 4,
    });
    this._maxConcurrency = assertLimitRequired(maxConcurrency, {
      name: 'maxConcurrency',
      className: 'PowerBulkhead',
      min: 1,
      fallback: 1,
    });
    this._queueCapacity = assertLimitRequired(queueCapacity, {
      name: 'queueCapacity',
      className: 'PowerBulkhead',
      min: 0,
      fallback: DEFAULT_QUEUE_CAPACITY,
    });
    this._partitioner = typeof partitioner === 'function' ? partitioner : null;
    this._nextPartition = 0;
    this._activeCount = 0;
    // Every admitted task, from submission to its outermost `finally`. `drain()`
    // waits on this rather than on `active`/`pending`, because those two have an
    // ordering hazard between them: when a permit is released the gate hands it to
    // the next queued task and decrements its `pending` **synchronously**, while the
    // predecessor's `.finally` decrements `active` in the same turn. There is a
    // moment where a task has been promoted from the queue to the active lane and has
    // not yet begun, and `active`/`pending` both read zero across it. Reading that
    // window resolves `drain()` while a task is still owed. One counter of admitted
    // work has no such gap.
    this._outstanding = 0;
    // Each partition owns its own queue budget. It used to be one global
    // budget enforced against a single `_pendingCount`, so partition A filling
    // its share refused partition C's work — measured, 2 partitions,
    // `maxConcurrency: 1`, `queueCapacity: 2`: after A queued two tasks, a task
    // in C was rejected with "PowerBulkhead queue is full" while **C had queued
    // nothing and its own permit was free**. That is the starvation this class
    // exists to prevent, caused by the one part of it that was not partitioned.
    //
    // `queueCapacity` is therefore read per partition, and the total that can
    // wait is `queueCapacity * partitions` rather than `queueCapacity`. That is
    // an observable admission change and is the point: a shared budget is not
    // isolation. The gate carries the same value as a backstop, but the
    // bulkhead checks first so the refusal is this class's error and not
    // `PowerPermitGate`'s.
    this._buckets = Array.from({ length: this._partitions }, () => ({
      gate: new PowerPermitGate({
        capacity: this._maxConcurrency,
        queueCapacity: this._queueCapacity,
      }),
    }));
    this._drainWaiters = new PowerQueue(POWER_QUEUE_INITIAL_CAPACITY);
    // FEAT-007: opt-in metrics. Off by default, so the common case pays nothing and allocates no closure.
    this._metrics = attach(this, 'bulkhead', options);
  }

  /** Number of partitions used for workload isolation. */
  get partitions() {
    return this._partitions;
  }

  /** Maximum concurrent tasks allowed per partition. */
  get maxConcurrency() {
    return this._maxConcurrency;
  }

  /**
   * Total number of currently queued tasks, across all partitions.
   *
   * The sum of the partitions' own queues. This used to be a separate
   * `_pendingCount` incremented and decremented by hand alongside the gates'
   * own `pending`; two counters for one quantity, which is how a refusal
   * decision came to be made against the wrong one.
   */
  get pending() {
    let total = 0;
    for (const bucket of this._buckets) total += bucket.gate.pending;
    return total;
  }

  /** Total number of running tasks across all partitions. */
  get active() {
    return this._activeCount;
  }

  /**
   * Maximum number of tasks that may wait, **per partition**.
   *
   * The total that can wait is `queueCapacity * partitions`. `0` is honoured
   * and means "refuse immediately rather than queue", matching
   * `PowerPermitGate`.
   */
  get queueCapacity() {
    return this._queueCapacity;
  }

  /**
   * True when **every** partition is at its queue budget, so no task that would
   * have to queue can be admitted anywhere.
   *
   * Under a per-partition budget "is the bulkhead full" cannot be a single
   * comparison against a global pending count, because a full partition says
   * nothing about the others. `every` is the reading that matches the name: the
   * bulkhead can accept no more work. `some` would report `isFull` as soon as
   * one partition was busy, which is the *normal* state of an isolated
   * bulkhead and would make the flag useless for backing off.
   */
  get isFull() {
    for (const bucket of this._buckets) {
      if (bucket.gate.pending < this._queueCapacity) return false;
    }
    return true;
  }

  /**
   * Enqueue a task for execution under partition isolation.
   * @param {Function} task Async callback to execute.
   * @param {Object} [options]
   * @param {any} [options.partitionKey] Optional key used to route the task to a partition.
   * @param {AbortSignal} [options.signal] Abort while queued: the returned promise
   *   rejects with an `AbortError` and the task never runs. Cancelling the *wait*
   *   is not cancelling the *work* - a task that already holds a permit runs to
   *   completion.
   * @returns {Promise<any>} Promise resolving or rejecting with task result.
   */
  run(task, options = {}) {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('PowerBulkhead.run() requires a function'));
    }

    const partition = this._choosePartition(options.partitionKey);
    const bucket = this._buckets[partition];
    const willQueue = bucket.gate.available === 0;
    // Against **this partition's** queue, not the bulkhead's total. The total
    // is a sum over partitions that are independently bounded, so comparing a
    // global pending count against one partition's budget is what let a noisy
    // partition refuse a critical one.
    if (willQueue && bucket.gate.pending >= this._queueCapacity) {
      return Promise.reject(new Error('PowerBulkhead queue is full'));
    }

    this._outstanding += 1;
    if (!willQueue) this._activeCount += 1;

    const permit = bucket.gate.acquire({ signal: options.signal });
    const result = permit.then(
      (release) => {
        if (willQueue) {
          // A queued task promotes from the partition's pending counter to the
          // active one. The pending side is the gate's, which `acquire()`
          // decrements itself as it hands the permit over; only the active
          // count is this class's to move.
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
        // The permit was refused, which is how a queued task is evicted or a
        // reset rejects it. The gate unwinds its own pending count; the
        // non-queued branch had counted the task in `_activeCount` when it was
        // submitted, so that has to be unwound here. Previously that was not
        // done for the queued branch, and the non-queued one was not unwound
        // at all, which permanently inflated `_activeCount` and left `drain()`
        // hanging forever.
        if (!willQueue) {
          this._activeCount = Math.max(0, this._activeCount - 1);
        }
        this._resolveDrainWaitersIfIdle();
        throw err;
      }
    );

    return result.finally(() => {
      this._outstanding = Math.max(0, this._outstanding - 1);
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
    this._outstanding += 1;
    this._activeCount += 1;
    const result = Promise.resolve().then(() => task());
    return result.finally(() => {
      release();
      this._activeCount = Math.max(0, this._activeCount - 1);
      this._outstanding = Math.max(0, this._outstanding - 1);
      this._resolveDrainWaitersIfIdle();
    });
  }

  /**
   * Wait for all active and queued tasks to complete.
   * @returns {Promise<void>}
   */
  drain() {
    if (this._outstanding === 0) {
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
      pending: this.pending,
      queueCapacity: this._queueCapacity,
      partitions: this._partitions,
      maxConcurrency: this._maxConcurrency,
      // Same reading as `isFull`: saturated means *nothing* can be admitted,
      // not that one partition is busy. See the getter for why `every` and
      // not `some` — a single busy partition is the normal state here.
      saturated: this.isFull,
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
   * @param {PowerBulkheadResetOptions} [options] - Reset options.
   * @returns {void}
   */
  reset(options = {}) {
    // `available` was documented here and ignored - the gates were always
    // restored to `maxConcurrency`. A caller who passed it got a bulkhead full
    // of permits anyway.
    const available = Number.isFinite(Number(options.available))
      ? Math.max(0, Math.floor(Number(options.available)))
      : this._maxConcurrency;
    const reason =
      options.reason instanceof Error
        ? options.reason
        : new Error(options.reason || 'PowerBulkhead reset');
    /** @type {BulkheadResetError} */
    const coded = reason;
    coded.code = coded.code || 'ERR_BULKHEAD_RESET';
    for (const bucket of this._buckets) {
      bucket.gate.reset({ available, reason: coded });
    }
    this._resolveDrainWaitersIfIdle();
  }

  /**
   * Alias for {@link PowerBulkhead#reset}, plus releasing the metrics
   * registration.
   *
   * A disposed bulkhead that stays registered is sampled forever: its
   * `stats()` keeps answering, so nothing fails visibly, and the collector
   * accumulates a series for an object nobody can reach. `guides/metrics.md`
   * lists this as one of the helpers that must detach in teardown, and it did
   * not.
   *
   * @param {PowerBulkheadResetOptions} [options] - Reset options.
   * @returns {void}
   */
  dispose(options) {
    detach(this._metrics);
    this._metrics = null;
    this.reset(options);
  }

  [Symbol.dispose]() {
    this.dispose();
  }

  /**
   * The partition a key belongs to: the explicit `partitioner` when given,
   * otherwise a hash of the key, and otherwise round-robin so keys spread
   * evenly when there is nothing to hash.
   *
   * @param {any} key
   * @returns {number} An index in `[0, partitions)`.
   */
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

  /**
   * djb2 hash, kept unsigned so the modulo below cannot produce a negative
   * index.
   *
   * @param {string} value
   * @returns {number}
   */
  _hashKey(value) {
    let hash = 5381;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash << 5) + hash + value.charCodeAt(i);
    }
    return hash >>> 0;
  }

  _resolveDrainWaitersIfIdle() {
    if (this._outstanding !== 0) return;

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
