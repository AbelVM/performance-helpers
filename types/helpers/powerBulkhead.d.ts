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
    constructor(options?: PowerBulkheadOptions);
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
    /** Number of partitions used for workload isolation. */
    get partitions(): number;
    /** Maximum concurrent tasks allowed per partition. */
    get maxConcurrency(): number;
    /**
     * Total number of currently queued tasks, across all partitions.
     *
     * The sum of the partitions' own queues. This used to be a separate
     * `_pendingCount` incremented and decremented by hand alongside the gates'
     * own `pending`; two counters for one quantity, which is how a refusal
     * decision came to be made against the wrong one.
     */
    get pending(): number;
    /** Total number of running tasks across all partitions. */
    get active(): number;
    /**
     * Maximum number of tasks that may wait, **per partition**.
     *
     * The total that can wait is `queueCapacity * partitions`. `0` is honoured
     * and means "refuse immediately rather than queue", matching
     * `PowerPermitGate`.
     */
    get queueCapacity(): number;
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
    get isFull(): boolean;
    /**
     * Enqueue a task for execution under partition isolation.
     * @param {Function} task Async callback to execute.
     * @param {Object} [options]
     * @param {any} [options.partitionKey] Optional key used to route the task to a partition.
     * @param {AbortSignal} [options.signal] Abort while queued: the returned promise
     *   rejects with an `AbortError` and the task never runs. Cancelling the *wait*
     *   is not cancelling the *work* - a task that already holds a permit runs to
     *   completion.
     * @param {number} [options.weight=1] Number of capacity units the task needs
     *   from its partition's `maxConcurrency`. Must be a whole number >= 1. A
     *   weight exceeding `maxConcurrency` is rejected with a `TypeError`, because
     *   such a task can never run.
     * @returns {Promise<any>} Promise resolving or rejecting with task result.
     */
    run(task: Function, options?: {
        partitionKey?: any;
        signal?: AbortSignal | undefined;
        weight?: number | undefined;
    }): Promise<any>;
    /**
     * Try to execute immediately without queuing.
     * @param {Function} task
     * @param {Object} [options]
     * @param {any} [options.partitionKey]
     * @param {number} [options.weight=1] Number of capacity units to reserve from
     *   the partition. Must be a whole number >= 1.
     * @returns {Promise<any>|null}
     */
    tryRun(task: Function, options?: {
        partitionKey?: any;
        weight?: number | undefined;
    }): Promise<any> | null;
    /**
     * Wait for all active and queued tasks to complete.
     * @returns {Promise<void>}
     */
    drain(): Promise<void>;
    /**
     * Snapshot of the bulkhead's counters.
     * @returns {{active:number, pending:number, queueCapacity:number, partitions:number, maxConcurrency:number, saturated:boolean, pressure:number, shed:number, partitionStates:Array<{active:number,pending:number,saturated:boolean}>}}
     */
    stats(): {
        active: number;
        pending: number;
        queueCapacity: number;
        partitions: number;
        maxConcurrency: number;
        saturated: boolean;
        pressure: number;
        shed: number;
        partitionStates: Array<{
            active: number;
            pending: number;
            saturated: boolean;
        }>;
    };
    /**
     * Alias for {@link stats}.
     *
     * See `guides/stats-naming.md` for why both spellings exist and why this
     * method is written out per class.
     */
    getStats(): {
        active: number;
        pending: number;
        queueCapacity: number;
        partitions: number;
        maxConcurrency: number;
        saturated: boolean;
        pressure: number;
        shed: number;
        partitionStates: Array<{
            active: number;
            pending: number;
            saturated: boolean;
        }>;
    };
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
    reset(options?: PowerBulkheadResetOptions): void;
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
    dispose(options?: PowerBulkheadResetOptions): void;
    /**
     * The partition a key belongs to: the explicit `partitioner` when given,
     * otherwise a hash of the key, and otherwise round-robin so keys spread
     * evenly when there is nothing to hash.
     *
     * @param {any} key
     * @returns {number} An index in `[0, partitions)`.
     */
    _choosePartition(key: any): number;
    /**
     * djb2 hash, kept unsigned so the modulo below cannot produce a negative
     * index.
     *
     * @param {string} value
     * @returns {number}
     */
    _hashKey(value: string): number;
    _resolveDrainWaitersIfIdle(): void;
    [Symbol.dispose](): void;
}
export default PowerBulkhead;
export type PowerBulkheadOptions = import("./jsdoc-types.js").PowerBulkheadOptions;
export type PowerBulkheadResetOptions = import("./jsdoc-types.js").PowerBulkheadResetOptions;
export type BulkheadResetError = import("./jsdoc-types.js").BulkheadResetError;
import { PowerPermitGate } from './powerPermitGate.js';
import { PowerQueue } from './powerQueue.js';
