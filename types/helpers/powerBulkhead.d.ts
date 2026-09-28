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
    _onError: ((err: any) => void) | null;
    _partitions: number;
    _maxConcurrency: number;
    _queueCapacity: number;
    _partitioner: ((key: any) => number) | null;
    _nextPartition: number;
    _pendingCount: number;
    _activeCount: number;
    _buckets: {
        gate: PowerPermitGate;
    }[];
    _drainWaiters: PowerQueue;
    /** Number of partitions used for workload isolation. */
    get partitions(): number;
    /** Maximum concurrent tasks allowed per partition. */
    get maxConcurrency(): number;
    /** Total number of currently queued tasks. */
    get pending(): number;
    /** Total number of running tasks across all partitions. */
    get active(): number;
    /** Maximum number of tasks that may wait in the queue. */
    get queueCapacity(): number;
    /** True when the bulkhead queue is saturated. */
    get isFull(): boolean;
    /**
     * Enqueue a task for execution under partition isolation.
     * @param {Function} task Async callback to execute.
     * @param {Object} [options]
     * @param {any} [options.partitionKey] Optional key used to route the task to a partition.
     * @returns {Promise<any>} Promise resolving or rejecting with task result.
     */
    run(task: Function, options?: {
        partitionKey?: any;
    }): Promise<any>;
    /**
     * Try to execute immediately without queuing.
     * @param {Function} task
     * @param {Object} [options]
     * @param {any} [options.partitionKey]
     * @returns {Promise<any>|null}
     */
    tryRun(task: Function, options?: {
        partitionKey?: any;
    }): Promise<any> | null;
    /**
     * Wait for all active and queued tasks to complete.
     * @returns {Promise<void>}
     */
    drain(): Promise<void>;
    /**
     * Snapshot of the bulkhead's counters.
     * @returns {{active:number, pending:number, queueCapacity:number, partitions:number, maxConcurrency:number, saturated:boolean}}
     */
    stats(): {
        active: number;
        pending: number;
        queueCapacity: number;
        partitions: number;
        maxConcurrency: number;
        saturated: boolean;
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
     * Alias for {@link PowerBulkhead#reset}.
     * @param {Object} [options] - Reset options.
     * @returns {void}
     */
    dispose(options?: Object): void;
    _choosePartition(key: any): number;
    _hashKey(value: any): number;
    _resolveDrainWaitersIfIdle(): void;
    [Symbol.dispose](): void;
}
export default PowerBulkhead;
export type PowerBulkheadOptions = import("./jsdoc-types.js").PowerBulkheadOptions;
export type PowerBulkheadResetOptions = import("./jsdoc-types.js").PowerBulkheadResetOptions;
export type BulkheadResetError = import("./jsdoc-types.js").BulkheadResetError;
import { PowerPermitGate } from './powerPermitGate.js';
import { PowerQueue } from './powerQueue.js';
