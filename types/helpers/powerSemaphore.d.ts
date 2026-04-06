export class PowerSemaphore {
    /**
     * Create a semaphore.
     * @param {number} [limit=1] Maximum number of concurrent permits.
     */
    constructor(limit?: number);
    _gate: PowerPermitGate;
    /** Maximum concurrent holders. */
    get limit(): number;
    /** Currently acquired permits. */
    get active(): number;
    /** Number of callers waiting for a permit. */
    get pending(): number;
    /** Number of permits still available. */
    get available(): number;
    /** True when the semaphore is fully acquired. */
    get isLocked(): boolean;
    /**
     * Acquire a permit asynchronously.
     * Resolves immediately when one is available; otherwise waits in FIFO order.
     * @returns {Promise<Function>} Promise resolving to the release callback.
     */
    acquire(): Promise<Function>;
    /**
     * Try to acquire a permit without waiting.
     * @returns {Function|null} Release callback when acquired, otherwise `null`.
     */
    tryAcquire(): Function | null;
    /**
     * Execute a callback while holding a permit.
     * The permit is released after the callback resolves or rejects.
     * @template T
     * @param {() => Promise<T> | T} fn Callback to run under a permit.
     * @returns {Promise<T>} The callback result.
     */
    run<T>(fn: () => Promise<T> | T): Promise<T>;
    /**
     * Reset the semaphore and reject any queued waiters.
     * @returns {void}
     */
    reset(): void;
}
export default PowerSemaphore;
import { PowerPermitGate } from './powerPermitGate.js';
