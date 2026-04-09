export class PowerBulkhead {
    /**
     * @param {Object} [options]
     * @param {number} [options.partitions=4] Number of isolated execution partitions.
     * @param {number} [options.maxConcurrency=1] Maximum concurrent tasks per partition.
     * @param {number} [options.queueCapacity=100] Maximum queued tasks across all partitions.
     * @param {Function} [options.partitioner] Function `(key)=>partitionIndex`.
     */
    constructor(options?: {
        partitions?: number | undefined;
        maxConcurrency?: number | undefined;
        queueCapacity?: number | undefined;
        partitioner?: Function | undefined;
    });
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
    _choosePartition(key: any): number;
    _hashKey(value: any): number;
    _resolveDrainWaitersIfIdle(): void;
}
export default PowerBulkhead;
import { PowerPermitGate } from './powerPermitGate.js';
import { PowerQueue } from './powerQueue.js';
