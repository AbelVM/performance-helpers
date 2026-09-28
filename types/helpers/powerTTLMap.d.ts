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
     * @typedef {import('./jsdoc-types.js').TTLMapEntry} TTLMapEntry
     */
    constructor(defaultTTL?: number, options?: {});
    _defaultTTL: number;
    _onExpire: ((key: any, value: any) => void) | null;
    /** @type {Map<any, TTLMapEntry>} */
    _map: Map<any, import("./jsdoc-types.js").TTLMapEntry>;
    /** @type {Map<any, number>} */
    _expirations: Map<any, number>;
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
     * Internal: remove an entry, invoking `onExpire` for its value.
     *
     * This helper centralizes expiry removal for `get`, `has`, `touch`, the
     * iterators and the size sweep. When the entry is expired it is removed from
     * the underlying map.
     *
     * Note it returns nothing. The JSDoc claimed `@returns {boolean} "true when
     * the entry is missing or expired"`, which has never been true - and no caller
     * reads a result, because the callers that need to know use `_checkExpire`,
     * which answers separately.
     *
     * @private
     * @param {any} key - Map key to check
     * @param {TTLMapEntry} [entry] - Stored entry, or `undefined` when the key is
     *   absent.
     * @returns {void}
     */
    private _expireKey;
    /**
     * Whether a key needs removing: absent, or present and past its expiry.
     * @param {any} key
     * @param {TTLMapEntry} [entry]
     * @returns {boolean}
     */
    _checkExpire(key: any, entry?: import("./jsdoc-types.js").TTLMapEntry): boolean;
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
    /**
     * Keep `_nextExpiryAt` pointing at the soonest live expiry, invalidating the
     * cached `size` shortcut when the entry that held it is gone or replaced.
     *
     * @param {number} prevExpiry - The key's expiry before this write, `0` if none.
     * @param {number} nextExpiry - The key's expiry after this write, `0` if none.
     * @returns {void}
     */
    _updateNextExpiryOnWrite(prevExpiry: number, nextExpiry: number): void;
    /**
     * Drop every expired entry the expiration index knows about, then recompute
     * the soonest remaining expiry.
     *
     * @param {number} now
     * @returns {void}
     */
    _sweepExpirations(now: number): void;
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
     * @param {(value:any, key:any, map:PowerTTLMap)=>void} cb
     * @param {any} [thisArg]
     * @returns {void}
     */
    forEach(cb: (value: any, key: any, map: PowerTTLMap) => void, thisArg?: any): void;
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
     * Default iterator yielding `[key, value]` pairs for non-expired entries.
     */
    [Symbol.iterator](): IterableIterator<[any, any]>;
    /**
     * Alias for {@link dispose}, so `using x = new X()` releases the instance
     * deterministically at scope exit.
     * @returns {void}
     */
    [Symbol.dispose](): void;
}
export default PowerTTLMap;
