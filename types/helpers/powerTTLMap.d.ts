/**
 * Lightweight Map-like store where each key has an optional TTL (milliseconds).
 * Entries expire lazily on access or iteration. Suitable when LRU/weighting
 * is unnecessary and a simple time-to-live map is desired.
 */
export class PowerTTLMap {
    /**
     * @param {number} [defaultTTL=0] Default TTL in milliseconds for keys set without explicit ttl (0 = no expiry).
     */
    /**
     * @typedef {Object} PowerTTLMapOptions
     * @property {(key:any,value:any)=>void} [onExpire]
     */
    constructor(defaultTTL?: number, options?: {});
    _defaultTTL: number;
    _onExpire: any;
    _map: Map<any, any>;
    _expirations: Map<any, any>;
    /**
     * Set a key with optional TTL (ms).
     * @param {any} key
     * @param {any} value
     * @param {number} [ttl] TTL in milliseconds for this key.
     * @returns {this}
     */
    set(key: any, value: any, ttl?: number): this;
    /**
     * Internal: remove entry if expired; returns true if removed or missing.
     *
     * This helper centralizes expiry checks for `get`, `has`, and iteration
     * paths. When an entry is expired it is removed from the underlying map.
     *
     * @private
     * @param {any} key - Map key to check
     * @param {{value:any,expiresAt:number}|undefined} entry - Stored entry or undefined
     * @returns {boolean} true when the entry is missing or expired (and removed)
     */
    private _expireKey;
    _checkExpire(key: any, entry: any): boolean;
    /**
     * Get a value, returning `undefined` when missing or expired.
     * @param {any} key
     * @returns {any|undefined}
     */
    get(key: any): any | undefined;
    /**
     * Check whether a key exists and is not expired.
     * @param {any} key
     * @returns {boolean}
     */
    has(key: any): boolean;
    /**
     * Delete a key.
     * @param {any} key
     * @returns {boolean}
     */
    delete(key: any): boolean;
    /**
     * Remove all entries.
     * @returns {void}
     */
    clear(): void;
    /**
     * Refresh TTL for an existing key. No-op if missing/expired.
     * @param {any} key
     * @param {number} [ttl]
     * @returns {boolean} True when TTL refreshed.
     */
    touch(key: any, ttl?: number): boolean;
    /**
     * Number of non-expired entries (purges expired entries lazily).
     * @returns {number}
     */
    get size(): number;
    /**
     * Iterate entries [key, value] skipping expired entries.
     * @returns {IterableIterator<[any, any]>}
     */
    entries(): IterableIterator<[any, any]>;
    /**
     * Iterate keys of non-expired entries.
     * @returns {IterableIterator<any>}
     */
    keys(): IterableIterator<any>;
    /**
     * Iterate values of non-expired entries.
     * @returns {IterableIterator<any>}
     */
    values(): IterableIterator<any>;
    /**
     * Call `cb` for each non-expired entry.
     * @param {Function} cb
     * @param {any} [thisArg]
     */
    forEach(cb: Function, thisArg?: any): void;
    /**
     * Default iterator yielding `[key, value]` pairs for non-expired entries.
     */
    [Symbol.iterator](): IterableIterator<[any, any]>;
}
export default PowerTTLMap;
