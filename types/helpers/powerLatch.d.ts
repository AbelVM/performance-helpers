export class PowerLatch {
    /**
     * Create a latch that waits for a single signal.
     * @returns {PowerLatch}
     */
    static one(): PowerLatch;
    /**
     * @typedef {import('./jsdoc-types.js').PowerLatchOptions} PowerLatchOptions
     * @typedef {import('./jsdoc-types.js').PowerLatchWaiter} PowerLatchWaiter
     * @typedef {import('./jsdoc-types.js').PowerLatchWaitOptions} PowerLatchWaitOptions
     */
    /**
     * @param {number} [count=1] - initial count required to release the latch
     * @param {PowerLatchOptions} [options] - `onAbort` is invoked with the
     *   rejection reason by {@link PowerLatch#abort}.
     */
    constructor(count?: number, options?: import("./jsdoc-types.js").PowerLatchOptions);
    _count: number;
    /** @type {Map<number, PowerLatchWaiter>} */
    _waiters: Map<number, import("./jsdoc-types.js").PowerLatchWaiter>;
    _nextWaiterToken: number;
    _aborted: boolean;
    /** @type {any} */
    _abortReason: any;
    /** @type {?((reason:any)=>void)} */
    _onAbort: ((reason: any) => void) | null;
    set onAbort(fn: ((reason: any) => void) | null);
    /**
     * Optional callback invoked when `abort()` is called: `(reason) => void`.
     */
    get onAbort(): ((reason: any) => void) | null;
    /**
     * Decrement the latch by one (or by `n` if provided). When the count
     * reaches zero all pending waiters are resolved.
     * @param {number} [n=1]
     * @returns {number} remaining count
     */
    countDown(n?: number): number;
    /**
     * Decrement the latch only if it's greater than zero.
     * Returns remaining count.
     * @returns {number}
     */
    decrementUnlessZero(): number;
    /**
     * Wait until the latch reaches zero. If already zero returns a resolved Promise.
     * @returns {Promise<void>}
     */
    /**
     * Wait until the latch reaches zero.
     * Options: `wait(timeoutMs)` or `wait({ timeout, signal })`.
     * If aborted via `abort()` pending waiters are rejected.
     * @param {number|PowerLatchWaitOptions} [opts]
     * @returns {Promise<void>}
     */
    wait(opts?: number | import("./jsdoc-types.js").PowerLatchWaitOptions): Promise<void>;
    /**
     * Reset the latch to a new count. Any existing waiters will be resolved
     * immediately if the new count is zero.
     * @param {number} [count=1]
     */
    reset(count?: number): void;
    /**
     * Number of remaining counts.
     * @returns {number}
     */
    get remaining(): number;
    /**
     * True when the latch is already released.
     * @returns {boolean}
     */
    get done(): boolean;
    /**
     * Detach a single waiter, either by token or by the waiter object itself.
     *
     * The object form exists because `_settleAll` and `wait`'s timeout path
     * already hold the waiter; the token form is what the abort listener has.
     *
     * @param {number|PowerLatchWaiter} waiterOrToken
     * @returns {?PowerLatchWaiter} The removed waiter, or `null` if it was already gone.
     */
    _removeWaiter(waiterOrToken: number | import("./jsdoc-types.js").PowerLatchWaiter): import("./jsdoc-types.js").PowerLatchWaiter | null;
    /**
     * Tear down every registered waiter, clearing its timer and abort listener,
     * then hand each `PowerDefer` to `settle`. Failures from either teardown are
     * swallowed so one bad waiter cannot strand the rest.
     *
     * @param {(defer: PowerDefer) => void} settle
     * @returns {void}
     */
    _settleAll(settle: (defer: PowerDefer) => void): void;
    _resolveAll(): void;
    /**
     * @param {any} err
     * @returns {void}
     */
    _rejectAll(err: any): void;
    /**
     * Abort pending waiters. If `reason` provided it will be used to reject waiters.
     * @param {any} [reason]
     */
    abort(reason?: any): void;
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
export default PowerLatch;
import { PowerDefer } from './powerDefer.js';
