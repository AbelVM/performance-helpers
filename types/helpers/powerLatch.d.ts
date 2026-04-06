export class PowerLatch {
    /**
     * Create a latch that waits for a single signal.
     * @returns {PowerLatch}
     */
    static one(): PowerLatch;
    /**
     * @typedef {Object} PowerLatchOptions
     * @property {(reason:any)=>void} [onAbort]
     */
    /**
     * @param {number} [count=1] - initial count required to release the latch
     */
    constructor(count?: number, options?: {});
    _count: number;
    /** @type {Array<{defer:PowerDefer, timer?:any, signalHandler?:Function, signal?:AbortSignal}>} */
    _waiters: Array<{
        defer: PowerDefer;
        timer?: any;
        signalHandler?: Function;
        signal?: AbortSignal;
    }>;
    _aborted: boolean;
    _abortReason: any;
    _onAbort: any;
    set onAbort(fn: any);
    /**
     * Optional callback invoked when `abort()` is called: `(reason) => void`.
     */
    get onAbort(): any;
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
     * @param {number|object} [opts]
     * @returns {Promise<void>}
     */
    wait(opts?: number | object): Promise<void>;
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
    _removeWaiter(waiter: any): any;
    _resolveAll(): void;
    _rejectAll(err: any): void;
    /**
     * Abort pending waiters. If `reason` provided it will be used to reject waiters.
     * @param {any} [reason]
     */
    abort(reason?: any): void;
}
export default PowerLatch;
import { PowerDefer } from './powerDefer.js';
