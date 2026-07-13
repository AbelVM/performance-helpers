/**
 * PowerTTLMap
 *
 * Lightweight Map-like store where each key has an optional TTL (milliseconds).
 * Entries expire lazily on access or iteration.
 *
 * @class PowerTTLMap
 * @public
 */
export class PowerTTLMap {
    /**
     * @param {number|PowerTTLMapOptions} [defaultTTL=0] Default TTL in milliseconds for keys set
     *   without explicit ttl (0 = no expiry). Accepts either a positional number or an options
     *   object `{ defaultTTL, onExpire }` for consistency with the other helpers.
     * @param {PowerTTLMapOptions} [options={}] Options object (used when the first arg is a number).
     */
    /**
     * @typedef {import('./jsdoc-types.js').PowerTTLMapOptions} PowerTTLMapOptions
     */
    constructor(defaultTTL?: number, options?: {});
    _defaultTTL: number;
    _onExpire: any;
    _map: Map<any, any>;
    _expirations: Map<any, any>;
    _nextExpiryAt: number;
    _nextExpiryDirty: boolean;
    /**
     * Resolve a TTL argument that may be either a positional number or an
     * options object `{ ttl }` (matching the `PowerCache.set` convention).
     * @private
     * @param {number|{ttl?:number}|undefined} ttl
     * @param {number} fallback Default TTL when `ttl` is nullish.
     * @returns {number} Resolved TTL in ms (0 = no expiry).
     */
    private _resolveTtl;
    /**
     * Set a key with optional TTL (ms).
     * @param {any} key
     * @param {any} value
     * @param {number|{ttl?:number}} [ttl] TTL in milliseconds for this key. Accepts either a
     *   positional number or an options object `{ ttl }` for consistency with `PowerCache.set`.
     * @returns {this}
     */
    set(key: any, value: any, ttl?: number | {
        ttl?: number;
    }): this;
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
     * @param {number|{ttl?:number}} [ttl]
     * @returns {boolean} True when TTL refreshed.
     */
    touch(key: any, ttl?: number | {
        ttl?: number;
    }): boolean;
    /**
     * Number of non-expired entries (purges expired entries lazily).
     * @returns {number}
     */
    get size(): number;
    _updateNextExpiryOnWrite(prevExpiry: any, nextExpiry: any): void;
    _sweepExpirations(now: any): void;
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
