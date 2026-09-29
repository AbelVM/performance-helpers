export class PowerPermitGate {
    /**
     * @param {PowerPermitGateOptions} [options]
     */
    constructor(options?: PowerPermitGateOptions);
    _capacity: number;
    _queueCapacity: number;
    _available: number;
    _waiters: PowerQueue;
    /**
     * Waiters that were aborted and are still physically in the queue.
     *
     * An abort is O(1): the entry is marked and the promise rejected, and the
     * entry is compacted out the next time the queue is drained. That is
     * deliberate - removing by reference from the ring buffer is O(n) per
     * cancellation, and a cancellation storm is exactly the case where you do
     * not want an O(n) walk per cancelled waiter. The counter keeps
     * {@link PowerPermitGate#pending} and {@link PowerPermitGate#isFull}
     * honest in the meantime.
     *
     * @type {number}
     * @private
     */
    private _cancelledWaiters;
    /** Maximum number of permits. */
    get capacity(): number;
    /** Currently available permits. */
    get available(): number;
    /** Number of queued waiters, excluding any that have been aborted. */
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
     * @returns {Promise<PowerReleaseFn>} Promise resolving to a release callback.
     */
    acquire(options?: {}): Promise<PowerReleaseFn>;
    /**
     * Try to acquire a permit without waiting.
     * @returns {PowerReleaseFn|null} Release callback when acquired, otherwise `null`.
     */
    tryAcquire(): PowerReleaseFn | null;
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
    /**
     * Release every resource this instance holds: queued waiters are rejected and
     * the listener registry is emptied.
     *
     * Idempotent, and safe to call while the instance is idle. Exists so the
     * instance works with `using` / `await using`.
     *
     * @returns {void}
     */
    dispose(): void;
    /**
     * Alias for {@link dispose}, so `using x = new X()` releases the instance
     * deterministically at scope exit.
     * @returns {void}
     */
    [Symbol.dispose](): void;
}
export type PowerReleaseFn = import("./jsdoc-types.js").PowerReleaseFn;
export type PowerPermitGateOptions = import("./jsdoc-types.js").PowerPermitGateOptions;
import { PowerQueue } from './powerQueue.js';
