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
     * @param {function(*):void} [options.onError] Invoked as `onError(err)`
     *   whenever a user-supplied `release()` or task hook throws. Added in 2.0;
     *   without it those failures were silently discarded, because the field was
     *   read but never assigned.
     */
    constructor(options?: {
        partitions?: number | undefined;
        maxConcurrency?: number | undefined;
        queueCapacity?: number | undefined;
        partitioner?: Function | undefined;
        onError?: ((arg0: any) => void) | undefined;
    });
    _onError: ((arg0: any) => void) | null;
    _partitions: number;
    _maxConcurrency: number;
    _queueCapacity: number;
    _partitioner: Function | null;
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
     * @param {Object} [options] - Reset options.
     * @param {number} [options.available] - Permits to restore per partition.
     *   Defaults to `maxConcurrency`.
     * @param {string|Error} [options.reason] - Rejection reason for queued waiters.
     * @returns {void}
     */
    reset(options?: {
        available?: number | undefined;
        reason?: string | Error | undefined;
    }): void;
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
import { PowerPermitGate } from './powerPermitGate.js';
import { PowerQueue } from './powerQueue.js';
