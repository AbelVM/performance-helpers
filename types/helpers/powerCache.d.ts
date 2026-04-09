/**
 * Exported helper that allows callers to reuse a `seen` WeakMap for
 * repeated deep-equality checks to avoid allocating a new WeakMap/WeakSet
 * structure on every call.
 * @param {*} a
 * @param {*} b
 * @param {WeakMap} [seen]
 * @returns {boolean}
 */
export function deepEqualWithSeen(a: any, b: any, seen?: WeakMap<any, any>): boolean;
/**
 * A small, fast key resolver for common cases where arguments are simple scalars.
 * - Fast path for primitive scalar args (string, number, boolean, null, undefined).
 * - Joins scalar args with `|` and prefixes type codes to avoid collisions.
 * - Falls back to `JSON.stringify(args)` when any arg is a non-scalar (object, function, symbol).
 *
 * This is intended as a performant default for hot paths where most calls use
 * simple identifiers (ids, numbers, short strings). It is deterministic but
 * not suitable for canonicalizing complex objects — provide a custom
 * `keyResolver` in that case.
 *
 * Example: `new PowerMemoizer(fn, { keyResolver: simpleArgsKey })`
 */
export function simpleArgsKey(...args: any[]): string;
export class PowerCache {
    [x: number]: () => void;
    /**
     * Create a PowerCache.
     * @param {Object} [options]
     * @param {number} [options.maxEntries=Infinity] Maximum number of entries.
     * @param {number} [options.maxWeight=Infinity] Maximum total weight across entries.
     * @param {function(*):number} [options.weightFn] Function to compute weight for a value.
     * @param {number} [options.defaultTTL=60000] Default TTL (ms) for entries.
     * @param {number} [options.maxPoolSize=1000] Maximum node pool size for reuse.
     * @param {boolean} [options.rejectOversized=false] If true, inserting an item whose weight > `maxWeight` will be rejected.
     * @param {function(*, *, string):void} [options.onEvict] Callback invoked when an item is evicted/deleted/rejected. Called as `(key, value, reason)` where reason is `'evicted'|'deleted'|'rejected-oversized'`.
     * @param {function(*, *):void} [options.onExpire] Callback invoked when an item expires. Called as `(key, value)`.
     * @param {number} [options.initialPoolSize=0] Prefill the internal node pool with this many nodes (capped by `maxPoolSize`).
     * @param {number} [options.maxCleanupPerTick=100] Default max nodes scanned per cleanup tick when running `startCleanup()`.
     * @param {boolean} [options.eagerCleanupOnRead=false] If true, `peek()` and `has()` will eagerly remove expired nodes when observed.
    * @throws {TypeError} When a non-object is provided as the options argument.
     */
    constructor({ maxEntries, maxWeight, weightFn, defaultTTL, maxPoolSize, rejectOversized, onEvict, onExpire, initialPoolSize, maxCleanupPerTick, eagerCleanupOnRead, defaultAsyncTimeout, }?: {
        maxEntries?: number | undefined;
        maxWeight?: number | undefined;
        weightFn?: ((arg0: any) => number) | undefined;
        defaultTTL?: number | undefined;
        maxPoolSize?: number | undefined;
        rejectOversized?: boolean | undefined;
        onEvict?: ((arg0: any, arg1: any, arg2: string) => void) | undefined;
        onExpire?: ((arg0: any, arg1: any) => void) | undefined;
        initialPoolSize?: number | undefined;
        maxCleanupPerTick?: number | undefined;
        eagerCleanupOnRead?: boolean | undefined;
    }, ...args: any[]);
    maxEntries: number;
    maxWeight: number;
    weightFn: (arg0: any) => number;
    defaultTTL: number;
    maxPoolSize: number;
    rejectOversized: boolean;
    onEvict: ((arg0: any, arg1: any, arg2: string) => void) | null;
    onExpire: ((arg0: any, arg1: any) => void) | null;
    maxCleanupPerTick: number;
    eagerCleanupOnRead: boolean;
    _map: Map<any, any>;
    _head: CacheNode | null;
    _tail: CacheNode | null;
    _pool: {
        key: null;
        value: null;
        weight: number;
        expiresAt: number;
        prev: null;
        next: null;
    }[];
    _currentWeight: number;
    _hits: number;
    _misses: number;
    _evictions: number;
    _rejected: number;
    _expirations: number;
    _cleanupTimer: number | null;
    _cleanupRunning: boolean;
    _cleanupParams: {
        interval: number;
        maxCleanupPerTick: number;
    } | null;
    _cleanupCursor: any;
    _cleanupCursorValid: boolean;
    _evictionCandidate: any;
    _inflightPromises: Map<any, any>;
    _defaultAsyncTimeout: number;
    /**
     * Allocate a pool node or create a new one.
     *
     * This helper either reuses a node from the internal `pool` or creates a
     * fresh node object. The returned node is initialized with the provided
     * key/value/weight/expiresAt and has its `prev`/`next` pointers nulled.
     *
     * @private
     * @param {*} key
     * @param {*} value
     * @param {number} weight
     * @param {number} expiresAt
     * @returns {CacheNode}
     */
    private _allocNode;
    /**
     * Reset and return a node to the pool for reuse.
     *
     * This helper clears the node fields and returns it to the node pool when
     * the pool has capacity. It is called for evicted or deleted nodes to
     * reduce allocation churn.
     *
     * @private
     * @param {CacheNode} node
     * @returns {void}
     */
    private _freeNode;
    /**
     * Remove a node that has expired.
     *
     * Performs map deletion, linked-list unlink, invokes `onExpire`, returns the
     * node to the pool, and updates bookkeeping counters (`misses` and
     * `expirations`). This helper is called from several expiration paths and
     * centralizes the necessary cleanup steps.
     *
     * @private
     * @param {CacheNode} node
     * @param {number} now - Current timestamp (ms) used for comparisons
     * @param {boolean} [countMiss=false] - When true, increment the `misses` counter for user-facing lookups.
     */
    private _removeExpiredNode;
    /**
     * Fetch a node and validate expiry.
     * @private
     * @param {*} key
     * @param {Object} [options]
     * @param {boolean} [options.ignoreExpiry=false]
     * @param {boolean} [options.countMiss=false]
     * @returns {CacheNode|null}
     */
    private _fetchValidNode;
    /**
     * Start a background refresh for an expired entry.
     *
     * If a refresh is already in flight for the key, this helper does nothing.
     * The refreshed value is written back to cache when the factory resolves.
     * Errors are swallowed so the stale value remains available.
     *
     * @private
     * @param {*} key
     * @param {Function} factory
     * @param {Object} [options]
     * @param {number} [options.ttl]
     * @param {number} [options.weight]
     * @returns {void}
     */
    private _refreshStaleEntry;
    /**
     * Append a node to the tail (mark it most-recently used).
     * This updates the linked-list pointers appropriately and is used when
     * inserting new nodes or promoting a node to MRU.
     *
     * @private
     * @param {CacheNode} node - Node to append at the tail.
     * @returns {void}
     */
    private _append;
    /**
     * Remove a node from the linked list without freeing it. The node's
     * `prev`/`next` references are updated on neighbors and the node's links
     * are nulled. Does not modify `this.map` or bookkeeping counters; callers
     * are responsible for those actions.
     *
     * @private
     * @param {CacheNode} node - Node to unlink from the list.
     * @returns {void}
     */
    private _remove;
    /**
     * Move an existing node to the tail (mark as most-recently used).
     * Implemented as an unlink followed by an append. No-op when node is
     * already the tail.
     *
     * @private
     * @param {CacheNode} node - Node to promote to MRU position.
     * @returns {void}
     */
    private _moveToTail;
    /**
     * Evict nodes from the head (least-recently used) until the cache
     * satisfies both `maxEntries` and `maxWeight` constraints. For each
     * evicted node `onEvict` is invoked if provided and the node is returned
     * to the node pool via `_freeNode`.
     *
     * @private
     * @returns {void}
     */
    private _evictIfNeeded;
    /**
     * Set a value in the cache (add or update).
     * Marks the entry as most-recently used.
     * If `rejectOversized` is enabled and the computed/explicit weight exceeds `maxWeight`,
     * the insertion will be rejected and `set` returns `false` (otherwise returns `this`).
     * @param {*} key - Cache key
     * @param {*} value - Value to store
     * @param {Object} [options]
     * @param {number} [options.ttl] - Time-to-live in ms. Use `null` or `Infinity` to disable expiration.
     * @param {number} [options.weight] - Optional explicit weight for the entry. If omitted, `weightFn` is used.
     * @returns {this|false} `this` on success, or `false` when insertion was rejected due to oversize.
     */
    set(key: any, value: any, { ttl, weight }?: {
        ttl?: number | undefined;
        weight?: number | undefined;
    }): this | false;
    /**
     * Retrieve a value and mark it as recently used.
     * @param {*} key
     * @returns {*|undefined} The stored value or `undefined` if missing/expired.
     */
    get(key: any): any | undefined;
    /**
     * Get a value without updating recency.
     * Returns `undefined` for missing or expired entries.
     * @param {*} key
     * @returns {*|undefined}
     */
    peek(key: any): any | undefined;
    /**
     * Check membership without affecting recency.
     * @param {*} key
     * @param {Object} [options]
     * @param {boolean} [options.ignoreExpiry=false] If true, consider expired entries as present.
     * @returns {boolean}
     */
    has(key: any, { ignoreExpiry }?: {
        ignoreExpiry?: boolean | undefined;
    }): boolean;
    /**
     * Atomically read-or-compute a value for `key`.
     * If the key is present and not expired the stored value is returned.
     * Otherwise `factory` is invoked to produce the value which is stored
     * in the cache and returned. `factory` may be a value (in which case it
     * is stored directly) or a function. If the function returns a Promise,
     * the Promise is returned and the resolved value is stored when it settles.
     *
     * Note: this method does not deduplicate concurrent async factories —
     * for async factories prefer `getOrSetAsync` or use
     * `PowerMemoizer` for inflight deduplication.
     *
     * @param {*} key
     * @param {Function|*} factory - Function that produces the value or a direct value.
     * @param {Object} [options]
     * @param {number} [options.ttl]
     * @param {number} [options.weight]
     * @param {boolean} [options.staleWhileRevalidate=false] If true, return an expired value immediately and refresh the cache in the background.
     * @returns {*|Promise<*>}
     */
    getOrSet(key: any, factory: Function | any, { ttl, weight, staleWhileRevalidate }?: {
        ttl?: number | undefined;
        weight?: number | undefined;
        staleWhileRevalidate?: boolean | undefined;
    }): any | Promise<any>;
    /**
     * Bulk set multiple entries. Accepts an iterable/array of [key, value] pairs.
     * Computes weight once per value and applies a single eviction pass at the end.
     * @param {Iterable<[*,*]>} entries
     * @param {Object} [options]
     * @param {number} [options.ttl]
     * @param {number} [options.weight]
     * @returns {this}
     */
    setMany(entries: Iterable<[any, any]>, { ttl, weight }?: {
        ttl?: number | undefined;
        weight?: number | undefined;
    }): this;
    /**
     * Bulk get multiple keys. Returns a Map of found entries.
     * @param {Iterable<*>} keys
     * @param {Object} [options]
     * @param {boolean} [options.ignoreExpiry=false]
     * @returns {Map}
     */
    getMany(keys: Iterable<any>, { ignoreExpiry }?: {
        ignoreExpiry?: boolean | undefined;
    }): Map<any, any>;
    /**
     * Touch an entry: update its recency and optionally refresh TTL without
     * reading or modifying the stored value.
     * @param {*} key
     * @param {number} [ttl] - Optional per-call TTL in ms. Use `null`/`Infinity` to disable expiry.
     * @returns {boolean} True if the entry existed (and was not expired), false otherwise.
     */
    touch(key: any, ttl?: number): boolean;
    /**
     * Async read-or-compute with inflight deduplication.
     * If a factory is already running for `key`, returns the same Promise.
     * Otherwise invokes `asyncFactory` and stores the resolved value in cache.
     * @param {*} key
     * @param {Function} asyncFactory - Function returning a Promise or value.
     * @param {Object} [options]
     * @param {number} [options.ttl]
     * @param {number} [options.weight]
     * @param {boolean} [options.staleWhileRevalidate=false] If true, return an expired value immediately and refresh the cache in the background.
     * @returns {Promise<*>}
     */
    getOrSetAsync(key: any, asyncFactory: Function, { ttl, weight, staleWhileRevalidate, timeout }?: {
        ttl?: number | undefined;
        weight?: number | undefined;
        staleWhileRevalidate?: boolean | undefined;
    }): Promise<any>;
    /**
     * Check membership without affecting recency and verify the stored value is deep-equal
     * to the provided `value`.
     *
     * Optimizations:
     * - Fast reference equality short-circuit
     * - Fast primitive checks
     * - Special-cases for Arrays, TypedArrays/ArrayBuffer, Date, RegExp, Map and Set
     * - WeakMap/WeakSet-based cycle detection
     *
     * @param {*} key
     * @param {*} value
     * @param {Object} [options]
     * @param {boolean} [options.ignoreExpiry=false] If true, consider expired entries as present.
     * @param {WeakMap} [options.seen] Optional reusable `seen` WeakMap for callers that
     *        perform many deep-equality checks and want to avoid per-call allocations.
     * @returns {boolean}
     */
    hasEqual(key: any, value: any, { ignoreExpiry, seen }?: {
        ignoreExpiry?: boolean | undefined;
        seen?: WeakMap<any, any> | undefined;
    }): boolean;
    /**
     * Variant accepting an explicit `seen` WeakMap for reuse across many checks.
     * @param {*} key
     * @param {*} value
     * @param {WeakMap} seen
     * @param {Object} [options]
     * @param {boolean} [options.ignoreExpiry=false]
     * @returns {boolean}
     */
    hasEqualWithSeen(key: any, value: any, seen: WeakMap<any, any>, { ignoreExpiry }?: {
        ignoreExpiry?: boolean | undefined;
    }): boolean;
    /**
     * Delete an entry from the cache.
     * @param {*} key
     * @returns {boolean} true if the key was removed.
     */
    delete(key: any): boolean;
    /**
     * Clear the cache and return nodes to the pool.
     * @returns {void}
     */
    clear(): void;
    /**
     * Remove expired entries by scanning from least-recently used to most.
     * @returns {void}
     */
    cleanupExpired(): void;
    /**
     * Cleanup expired entries, scanning up to `maxScan` nodes.
     * Scanning resumes from an internal cursor so repeated small passes will cover the list
     * without repeatedly scanning the head of a very large cache. When the end is reached the
     * cursor wraps to the head.
     * @param {number} [maxScan=Infinity] Maximum nodes to scan in this pass.
     * @returns {number} Number of nodes scanned
     */
    cleanupExpiredUpTo(maxScan?: number): number;
    /**
     * Start periodic, non-blocking cleanup.
     * Accepts either a numeric interval (ms) or an options object `{ interval, maxCleanupPerTick }`.
     * The loop is implemented with `setTimeout` and scans up to `maxCleanupPerTick` nodes per pass
     * to avoid long event-loop stalls.
     * Note: call `stopCleanup()` to stop the periodic timer (for example, on application shutdown)
     * to ensure the internal timer is cleared and resources can be reclaimed.
     * @param {number|Object} [intervalOrOptions]
     * @param {number} [intervalOrOptions.interval] Interval between cleanup passes in ms.
     * @param {number} [intervalOrOptions.maxCleanupPerTick] Max nodes to scan per pass.
     * @returns {void}
     */
    startCleanup(intervalOrOptions?: number | Object): void;
    /**
     * Stop periodic cleanup.
     * @returns {void}
     */
    stopCleanup(): void;
    /**
     * Prototype tick used by the cleanup timer loop. Separated to avoid
     * allocating a per-call closure inside `startCleanup()`.
     * @private
     */
    private _cleanupTick;
    /**
     * Current number of entries in cache.
     * @returns {number}
     */
    get size(): number;
    /**
     * Hit rate as a fraction (hits / (hits + misses)).
     * @returns {number}
     */
    get hitRate(): number;
    /**
     * Return runtime statistics for the cache.
     * @returns {{size:number, weight:number, hits:number, misses:number, evictions:number, rejected:number, poolSize:number}}
     */
    stats(): {
        size: number;
        weight: number;
        hits: number;
        misses: number;
        evictions: number;
        rejected: number;
        poolSize: number;
    };
    /**
     * Resize the cache limits and evict if necessary.
     * @param {Object} options
     * @param {number} [options.maxEntries]
     * @param {number} [options.maxWeight]
     */
    resize({ maxEntries, maxWeight }?: {
        maxEntries?: number | undefined;
        maxWeight?: number | undefined;
    }): void;
    /**
     * Iterate entries in LRU or MRU order.
     * @param {'LRU'|'MRU'} [order='MRU']
     * @returns {IterableIterator<[*,*]>}
     */
    entries(order?: "LRU" | "MRU"): IterableIterator<[any, any]>;
    /**
     * Iterate keys in LRU or MRU order.
     * @param {'LRU'|'MRU'} [order='MRU']
     */
    keys(order?: "LRU" | "MRU"): Generator<any, void, unknown>;
    /**
     * Iterate values in LRU or MRU order.
     * @param {'LRU'|'MRU'} [order='MRU']
     */
    values(order?: "LRU" | "MRU"): Generator<any, void, unknown>;
    [Symbol.iterator](): IterableIterator<[any, any]>;
}
/**
 * PowerMemoizer
 *
 * A small memoization wrapper backed by `PowerCache`.
 * It memoizes synchronous values and Promise-returning functions.
 * Concurrent calls for the same arguments are deduplicated (single inflight Promise).
 * Rejected Promises are not cached.
 *
 * Usage (constructor returns a callable memoized function when given `fn`):
 * const fetcher = async (id) => await fetchData(id)
 * const memoizedFetch = new PowerMemoizer(fetcher, { cacheOptions: { defaultTTL: 1000 } })
 * // call the memoized function directly
 * await memoizedFetch(1)
 *
 * @class PowerMemoizer
 */
export class PowerMemoizer {
    /**
     * Create a PowerMemoizer.
     * @param {Function} [fn] - Optional function to memoize immediately.
     * @param {Object} [options]
     * @param {function(...*):string} [options.keyResolver] - Function that maps the wrapped call args to a cache key. Defaults to `JSON.stringify` on args.
     *   Note: `JSON.stringify(args)` is convenient but can be expensive for large or deeply-nested
     *   arguments. If the wrapped function is on a hot path, provide a custom `keyResolver`
     *   that cheaply and deterministically maps arguments to keys (for example, join simple
     *   scalar args with a separator or use a fast hashing function).
     * @param {Object} [options.cacheOptions] - Options forwarded to the underlying `PowerCache` constructor. Supported keys: `maxEntries` (number), `maxWeight` (number), `weightFn` (function(value):number), `defaultTTL` (number, ms), `maxPoolSize` (number), `rejectOversized` (boolean), `onEvict` (function(key, value, reason)), `onExpire` (function(key, value)), `initialPoolSize` (number), `maxCleanupPerTick` (number). See `PowerCache` constructor JSDoc for details.
     * @param {number} [options.ttl] - Default TTL (ms) used when constructing the memoized wrapper for `fn`.
     * @param {number} [options.weight] - Default weight used when constructing the memoized wrapper for `fn`.
     */
    constructor(fn?: Function, options?: {
        keyResolver?: ((...arg0: any[]) => string) | undefined;
        cacheOptions?: Object | undefined;
        ttl?: number | undefined;
        weight?: number | undefined;
    });
    keyResolver: (...arg0: any[]) => string;
    cache: PowerCache;
    _inflight: Map<any, any>;
    _defaultMemoizeOptions: {};
    run: (() => never) | undefined;
    _originalFn: any;
    /**
     * Wrap a function with memoization.
     * @private
     * @param {Function} fn - Function to memoize. May return a Promise.
     * @param {Object} [options]
     * @param {number} [options.ttl] - Per-entry TTL in ms (overrides cache default)
     * @param {number} [options.weight] - Optional explicit weight for the entry
     * @returns {Function} Memoized function
     */
    private _memoize;
    /**
     * Public API to memoize an arbitrary function using this PowerMemoizer instance's cache.
     * Mirrors the behavior used by the constructor when a function is supplied —
     * returns a callable memoized function with helpers attached (`get`, `has`, `delete`, `clear`, `stats`, `cache`).
     * @param {Function} fn - Function to memoize
     * @param {Object} [options] - Optional per-wrapper options { ttl, weight }
     * @returns {Function} Memoized function
     */
    memoize(fn: Function, options?: Object): Function;
    /**
     * Retrieve a cached value for the given call args (if present).
     * @param  {...*} args
     * @returns {*|undefined}
     */
    get(...args: any[]): any | undefined;
    /**
     * Check presence for the given call args.
     * @param  {...*} args
     * @returns {boolean}
     */
    has(...args: any[]): boolean;
    /**
     * Delete the cached entry for the given call args.
     * Also clears any inflight Promise for the key.
     * @param  {...*} args
     * @returns {boolean}
     */
    delete(...args: any[]): boolean;
    /**
     * Clear all cached entries and any inflight markers.
     * @returns {void}
     */
    clear(): void;
    /**
     * Expose underlying cache stats.
     * @returns {Object}
     */
    stats(): Object;
}
/**
 * PowerTimedCache
 *
 * A thin convenience wrapper around `PowerCache` for the common pure-TTL
 * use-case. It constructs an internal `PowerCache` with the provided `ttl`
 * used as the cache `defaultTTL` and automatically starts the periodic
 * cleanup loop. The wrapper delegates common cache methods to the
 * underlying `PowerCache` instance.
 *
 * @example
 * const timed = new PowerTimedCache(60000, { maxEntries: 100, interval: 10000 });
 * timed.set('k', 1);
 * // entries will be automatically expired by the background cleaner
 *
 * @class PowerTimedCache
 */
export class PowerTimedCache {
    [x: number]: () => void;
    /**
     * @param {number} ttl - Default TTL in milliseconds for entries.
     * @param {Object} [options]
     * @param {number} [options.maxEntries] - Forwarded to `PowerCache`.
     * @param {number} [options.interval] - Cleanup interval (ms) for automatic cleanup.
     * @param {number} [options.maxCleanupPerTick] - Max nodes scanned per cleanup tick.
     * @param {Object} [options.cacheOptions] - Additional options forwarded to `PowerCache`.
     */
    constructor(ttl: number, { maxEntries, interval, maxCleanupPerTick, cacheOptions }?: {
        maxEntries?: number | undefined;
        interval?: number | undefined;
        maxCleanupPerTick?: number | undefined;
        cacheOptions?: Object | undefined;
    });
    cache: PowerCache;
    get(key: any): any;
    set(key: any, value: any, options: any): false | PowerCache;
    has(key: any, options: any): boolean;
    delete(key: any): boolean;
    clear(): void;
    stats(): {
        size: number;
        weight: number;
        hits: number;
        misses: number;
        evictions: number;
        rejected: number;
        poolSize: number;
    };
    startCleanup(intervalOrOptions: any): void;
    stopCleanup(): void;
    get size(): number;
    get hitRate(): number;
    entries(order: any): IterableIterator<[any, any]>;
    keys(order: any): Generator<any, void, unknown>;
    values(order: any): Generator<any, void, unknown>;
}
export type CacheNode = {
    key: any;
    value: any;
    weight: number;
    expiresAt: number;
    prev: CacheNode | null;
    next: CacheNode | null;
};
export type PowerCacheOptions = {
    maxEntries?: number | undefined;
    maxWeight?: number | undefined;
    weightFn?: ((arg0: any) => number) | undefined;
    defaultTTL?: number | undefined;
    maxPoolSize?: number | undefined;
    rejectOversized?: boolean | undefined;
    onEvict?: ((arg0: any, arg1: any, arg2: string) => void) | undefined;
    onExpire?: ((arg0: any, arg1: any) => void) | undefined;
    initialPoolSize?: number | undefined;
    maxCleanupPerTick?: number | undefined;
    eagerCleanupOnRead?: boolean | undefined;
};
