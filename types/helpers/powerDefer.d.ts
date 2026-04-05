export class PowerDefer {
    _settled: boolean;
    _status: string;
    /** @type {Promise<any>} */
    promise: Promise<any>;
    /**
     * Resolve the deferred promise. No-op if already settled.
     * @param {any} value
     * @returns {void}
     */
    resolve(value: any): void;
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
