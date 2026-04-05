/**
 * Deferred promise primitive.
 * Separates a `Promise` from its `resolve`/`reject` functions.
 * Useful for barriers and manual promise coordination.
 *
 * @example
 * const d = new PowerDefer();
 * setTimeout(() => d.resolve(42), 10);
 * await d.promise; // 42
 */
export class PowerDefer {
    _settled: boolean;
    /** @type {Promise<any>} */
    promise: Promise<any>;
    _resolve: (v: any) => void;
    _reject: (err: any) => void;
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
}
export default PowerDefer;
