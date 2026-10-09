export class PowerSemaphore {
    /**
     * Create a semaphore.
     * @param {number} [limit=1] Maximum number of concurrent permits.
     */
    constructor(limit?: number, queueCapacity?: undefined);
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
     * Maximum number of waiters allowed in the queue, or `Infinity` when unbounded.
     *
     * Proxied from the gate rather than kept private. `PowerSemaphore` used to
     * build a gate that could queue without limit and expose neither the bound nor
     * whether it had been reached, so a caller using this class — the one most
     * people reach for — could neither cap the queue nor observe it filling. Both
     * halves of the primitive were unreachable through the wrapper.
     *
     * @returns {number}
     */
    get queueCapacity(): number;
    /**
     * True when the waiting queue is saturated.
     *
     * Counted against live waiters only, so a burst of cancellations does not read
     * as a full queue.
     *
     * @returns {boolean}
     */
    get isFull(): boolean;
    /**
     * Acquire a permit asynchronously.
     * Resolves immediately when one is available; otherwise waits in FIFO order.
     * @param {{signal?: AbortSignal}} [options] - Pass `options.signal` to stop
     *   waiting: the returned promise rejects with an `AbortError` and the caller
     *   leaves the queue instead of holding a slot until a permit arrives.
     * @returns {Promise<function():void>} Promise resolving to the release
     *   callback. Spelled as a call signature rather than `Function` because
     *   `Function` is not assignable to `() => void`, so `.then((release) =>
     *   release())` - the documented way to use it - failed to type-check for
     *   consumers.
     */
    acquire(options?: {
        signal?: AbortSignal;
    }): Promise<() => void>;
    /**
     * Try to acquire a permit without waiting.
     * @returns {PowerReleaseFn|null} Release callback when acquired, otherwise `null`.
     */
    tryAcquire(): PowerReleaseFn | null;
    /**
     * Execute a callback while holding a permit.
     * The permit is released after the callback resolves or rejects.
     *
     * `options` is forwarded to {@link acquire}, so `{ signal }` cancels the
     * *wait* for a permit. It used to be accepted and thrown away — this method
     * took only `fn` — so a caller who mirrored `acquire()` got a promise that
     * could not be cancelled and, with an already-aborted signal, hung until a
     * permit happened to be released. `run` is the form people reach for first,
     * so cancellation matters more here than on `acquire`.
     *
     * @template T
     * @param {() => Promise<T> | T} fn Callback to run under a permit.
     * @param {{signal?: AbortSignal}} [options] Forwarded to {@link acquire}.
     * @returns {Promise<T>} The callback result.
     */
    run<T>(fn: () => Promise<T> | T, options?: {
        signal?: AbortSignal;
    }): Promise<T>;
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
    /**
     * Asynchronous disposal hook (thin wrapper). Forwards to sync disposal.
     * @returns {Promise<void>}
     */
    [Symbol.asyncDispose](): Promise<void>;
}
export default PowerSemaphore;
export type PowerReleaseFn = import("./jsdoc-types.js").PowerReleaseFn;
import { PowerPermitGate } from './powerPermitGate.js';
