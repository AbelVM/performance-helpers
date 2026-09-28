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
     * @returns {Promise<function():void>} Promise resolving to the release
     *   callback. Spelled as a call signature rather than `Function` because
     *   `Function` is not assignable to `() => void`, so `.then((release) =>
     *   release())` - the documented way to use it - failed to type-check for
     *   consumers.
     */
    acquire(): Promise<() => void>;
    /**
     * Try to acquire a permit without waiting.
     * @returns {PowerReleaseFn|null} Release callback when acquired, otherwise `null`.
     */
    tryAcquire(): PowerReleaseFn | null;
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
    /**
     * Release every resource this instance holds.
     *
     * Idempotent, and safe to call while the instance is idle. Exists so the
     * instance works with `using` / `await using` and gives callers an explicit
     * name to call.
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
export default PowerSemaphore;
export type PowerReleaseFn = import("./jsdoc-types.js").PowerReleaseFn;
import { PowerPermitGate } from './powerPermitGate.js';
