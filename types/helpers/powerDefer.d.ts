/**
 * PowerDefer
 *
 * Deferred promise utility exposing `promise`, `resolve` and `reject` helpers.
 * Useful when needing a promise whose resolution is controlled externally.
 *
 * @class PowerDefer
 */
export class PowerDefer {
    _settled: boolean;
    /** @type {'pending'|'fulfilled'|'rejected'} */
    _status: "pending" | "fulfilled" | "rejected";
    /** @type {Promise<any>} */
    promise: Promise<any>;
    /**
     * Resolve the deferred promise. No-op if already settled.
     *
     * `value` is optional because the common case is a signal rather than a
     * payload: `PowerLatch` resolves each waiter's deferred with no argument to
     * fulfil a `Promise<void>`, and requiring `resolve(undefined)` at every such
     * call site would be noise.
     *
     * @param {any} [value]
     * @returns {void}
     */
    resolve(value?: any): void;
    /**
     * Reject the deferred promise. No-op if already settled.
     * @param {any} err
     * @returns {void}
     */
    reject(err: any): void;
    /**
     * Whether the deferred has been settled.
     * @returns {boolean}
     */
    get settled(): boolean;
    /**
     * Status of the deferred: 'pending' | 'fulfilled' | 'rejected'
     * @returns {'pending'|'fulfilled'|'rejected'}
     */
    get status(): "pending" | "fulfilled" | "rejected";
    /**
     * Convenience boolean: true if resolved successfully
     * @returns {boolean}
     */
    get fulfilled(): boolean;
    /**
     * Convenience boolean: true if rejected
     * @returns {boolean}
     */
    get rejected(): boolean;
}
export default PowerDefer;
