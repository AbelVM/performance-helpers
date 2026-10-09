/**
 * PowerDeduplication
 *
 * Time-windowed deduplicator. Tracks keys seen within a TTL window and
 * prevents re-emitting/reprocessing the same key within that window.
 *
 * @class PowerDeduplication
 * @public
 */
export class PowerDeduplication {
    /**
     * @typedef {import('./jsdoc-types.js').PowerDeduplicationOptions} PowerDeduplicationOptions
     */
    /**
     * @param {number | PowerDeduplicationOptions} [options]
     */
    constructor(options?: number | import("./jsdoc-types.js").PowerDeduplicationOptions);
    /** @type {Map<any, number>} */
    /**
     * Test if key is duplicate. If not seen (or expired), mark it as seen and return false.
     * If seen within TTL, return true.
     * @param {any} key
     * @returns {boolean}
     */
    has(key: any): boolean;
    /**
     * Mark key as seen regardless of previous state.
     * @param {any} key
     * @returns {void}
     */
    mark(key: any): void;
    /**
     * Remove key from dedup set.
     * @param {any} key
     * @returns {boolean}
     */
    delete(key: any): boolean;
    /**
     * Clear all keys.
     * @returns {void}
     */
    clear(): void;
    /**
     * Alias for clear.
     * @returns {void}
     */
    reset(): void;
    /** @param {number} now */ _prune(now: number): void;
    get size(): number;
    get length(): number;
    isEmpty(): boolean;
    dispose(): void;
    [Symbol.dispose](): void;
    [Symbol.asyncDispose](): Promise<void>;
}
export default PowerDeduplication;
