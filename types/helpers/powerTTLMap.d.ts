/**
 * @typedef {import('./jsdoc-types.js').PowerTTLMapOptions} PowerTTLMapOptions
 * @typedef {import('./jsdoc-types.js').TTLMapEntry} TTLMapEntry
 */
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
    constructor(defaultTTL?: number | PowerTTLMapOptions, options?: PowerTTLMapOptions);
    /** @type {Map<any, TTLMapEntry>} */
    /** @type {Map<any, number>} */
    /**
     * Resolve a TTL argument that may be either a positional number or an
     * options object `{ ttl }` (matching the `PowerCache.set` convention).
     * @private
     * @param {number|{ttl?:number}|undefined} ttl
     * @param {number} fallback Default TTL when `ttl` is nullish.
     * @returns {number} Resolved TTL in ms (0 = no expiry).
     */
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
    /**
     * Whether a key needs removing: absent, or present and past its expiry.
     * @param {any} key
     * @param {TTLMapEntry} [entry]
     * @returns {boolean}
     */
    _checkExpire(key: any, entry?: TTLMapEntry): boolean;
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
    /**
     * Alias for {@link PowerTTLMap#clear}.
     *
     * `clear()` here empties the container, and "reset" is a natural second word
     * for exactly that - so a caller who reaches for `reset()` on this class gets
     * the obvious thing instead of a `TypeError`. No limiter gets this alias: for
     * `PowerThrottle` and `PowerPermitGate`, `reset()` *refills* and `clear()`
     * would read as the opposite, and the two are deliberately not synonyms.
     *
     * @returns {void}
     */
    reset(): void;
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
     * Number of entries currently resident in the map.
     *
     * **This is `Map.size`, not "how many entries are still live".** The two
     * used to be the same getter, and that was a design smell: reading `.size`
     * called `_sweepExpirations`, which iterates the expiration index, removes
     * entries, and fires `onExpire` for each. A property read with a callback
     * side effect is not a property read — it is an operation wearing a
     * property's syntax, so `if (map.size)` was a mutation, a `size` check in a
     * render loop was O(k) per frame, and the cost of the answer was invisible
     * at the call site.
     *
     * Expired-but-not-yet-swept entries are resident and are therefore counted.
     * That is the honest meaning of the number, it is O(1), and it is what
     * `Map` users expect. Use {@link PowerTTLMap#expiredCount} when you want the
     * live count, or {@link PowerTTLMap#purge} to actually collect.
     *
     * @returns {number}
     */
    get size(): number;
    /**
     * How many resident entries are past their expiry and awaiting collection.
     *
     * The live count is `size - expiredCount`. Read-only: this does not sweep and
     * does not fire `onExpire`, so it is safe to use as a diagnostic without
     * changing the map. It does walk the expiration index, so it is O(k) in the
     * number of entries that *have* an expiry — which is why the hot path reads
     * {@link PowerTTLMap#size} and this is for reporting.
     *
     * @returns {number}
     */
    get expiredCount(): number;
    /**
     * Collect every entry that is already past its expiry, firing `onExpire` for
     * each.
     *
     * The explicit spelling of what `size` used to do implicitly. Reads and
     * `expiredCount` are pure; collection is opt-in.
     *
     * @returns {number} How many entries were removed.
     */
    purge(): number;
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
     *
     * Expired entries encountered during the walk are **collected** as a side
     * effect, firing `onExpire`. That is deliberate and is a different situation
     * from {@link PowerTTLMap#size}: iteration is an operation, so a caller can
     * see it happen, whereas a property read cannot.
     *
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
     * **Afterwards the map is inert rather than reusable: `set()` throws.** That is
     * the fix in CACHE-014, and it is a deliberate choice against the alternative of
     * leaving the instance writable. `dispose()` neutralises `clear()` so a second
     * call is a no-op, so an instance that still accepted writes would hold entries
     * the caller had no way to remove. Reads keep working and report an empty map.
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
    /**
     * Asynchronous disposal hook (thin wrapper). Forwards to sync disposal.
     * @returns {Promise<void>}
     */
    [Symbol.asyncDispose](): Promise<void>;
}
export default PowerTTLMap;
export type PowerTTLMapOptions = import("./jsdoc-types.js").PowerTTLMapOptions;
export type TTLMapEntry = import("./jsdoc-types.js").TTLMapEntry;
