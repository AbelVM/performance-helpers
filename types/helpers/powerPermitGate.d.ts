export class PowerPermitGate {
    /**
     * @param {Object} [options]
     * @param {number} [options.capacity=1]
     * @param {number} [options.queueCapacity=Infinity]
     * @param {number} [options.initialTokens]
     */
    constructor(options?: {
        capacity?: number | undefined;
        queueCapacity?: number | undefined;
        initialTokens?: number | undefined;
    });
    _capacity: number;
    _queueCapacity: number;
    _available: number;
    _waiters: PowerQueue;
    /** Maximum number of permits. */
    get capacity(): number;
    /** Currently available permits. */
    get available(): number;
    /** Number of queued waiters. */
    get pending(): number;
    /** Maximum number of waiters allowed in the queue. */
    get queueCapacity(): number;
    /** True when the waiting queue is saturated. */
    get isFull(): boolean;
    /** Number of permits currently held. */
    get active(): number;
    /**
     * Acquire a permit asynchronously.
     * Resolves immediately when a permit is available; otherwise waits in FIFO order.
     * @returns {Promise<Function>} Promise resolving to a release callback.
     */
    acquire(): Promise<Function>;
    /**
     * Try to acquire a permit without waiting.
     * @returns {Function|null} Release callback when acquired, otherwise `null`.
     */
    tryAcquire(): Function | null;
    /**
     * Release one or more permits back to the gate.
     * @param {number} [count=1]
     */
    release(count?: number): void;
    /**
     * Reset the gate and reject any waiting callers.
     * @param {Object} [options]
     * @param {number} [options.available] Number of permits to restore after reset.
     * @param {Error} [options.reason] Optional rejection reason for queued waiters.
     */
    reset(options?: {
        available?: number | undefined;
        reason?: Error | undefined;
    }): void;
    _makeRelease(): () => void;
    _grant(): () => void;
}
import { PowerQueue } from './powerQueue.js';
