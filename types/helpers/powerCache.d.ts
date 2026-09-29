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
 *
 * @public
 */
export function simpleArgsKey(...args: any[]): string;
/**
 * PowerCache
 *
 * In-memory cache with weight-aware eviction, TTLs and optional cleanup.
 * Provides MRU/LRU iteration helpers and hooks for eviction/expiration.
 *
 * @class PowerCache
 * @public
 */
export class PowerCache {
    /**
     * Create a PowerCache.
     *
     * The options type is the `PowerCacheOptions` typedef, not a second inline
     * list. The two had drifted: `defaultAsyncTimeout`, `onError` and `policy`
     * were destructured here and documented in the typedef, but absent from a
     * duplicated `@param` list on this constructor - so TypeScript synthesised an
     * options type without them, the body failed to type-check against its own
     * signature, and the three options were missing from the published
     * declarations. One source of truth, not two that have to be kept in step.
     *
     * @param {PowerCacheOptions} [options]
     * @throws {TypeError} When a non-object is provided as the options argument.
     */
    constructor({ maxEntries, maxWeight, weightFn, defaultTTL, maxPoolSize, rejectOversized, onEvict, onExpire, initialPoolSize, maxCleanupPerTick, eagerCleanupOnRead, defaultAsyncTimeout, onError, policy, admission, windowSize, now, }?: PowerCacheOptions, ...args: any[]);
    maxEntries: number;
    maxWeight: number;
    maxPoolSize: number;
    weightFn: ((arg0: any) => number) | null;
    defaultTTL: number;
    _now: () => number;
    rejectOversized: boolean;
    onEvict: ((arg0: any, arg1: any, arg2: string) => void) | null;
    onError: ((arg0: any, arg1: string) => void) | null;
    /** number of times `weightFn` threw; a non-zero value means `maxWeight`
     *  could not be enforced and should be surfaced by the caller. */
    _weightErrors: number;
    onExpire: ((arg0: any, arg1: any) => void) | null;
    maxCleanupPerTick: number;
    eagerCleanupOnRead: boolean;
    _map: Map<any, any>;
    _head: import("./jsdoc-types.js").CacheNode | null;
    _tail: any;
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
    _rejectedAdmission: number;
    _expirations: number;
    _cleanupTimer: any;
    _cleanupRunning: boolean;
    _cleanupParams: {
        interval: number;
        maxCleanupPerTick: number;
    } | null;
    _cleanupCursor: any;
    _cleanupCursorValid: boolean;
    _evictionCandidate: any;
    /**
     * Eviction policy. `'lru'` (default) keeps the previous single-recency-list
     * behaviour. `'slru'` splits the list into a probation segment and a
     * protected segment and promotes on access, which makes the cache far more
     * resistant to a one-off sequential scan evicting the working set.
     */
    _policy: string;
    /**
     * Frequency sketch backing `{ admission: 'tinylfu' }`, or `null` when
     * admission is off. See {@link SmallLfuSketch}.
     * @type {SmallLfuSketch|null}
     * @private
     */
    private _sketch;
    /**
     * Size of the W-TinyLFU admission window, or `0` for no window.
     *
     * The window is the last `windowSize` entries of the recency list: new keys
     * land there unconditionally, and only the window's oldest entry is
     * arbitrated against the main-space victim. That is what lets a one-shot
     * scan be absorbed in a region it cannot displace the working set from.
     *
     * It defaults to **`0` — the window is off** — and that is the shipped
     * behaviour of `admission: 'tinylfu'`. See the note below and
     * `design/0001-tinylfu-admission-window.md`.
     *
     * Arming is last because it depends on `_sketch` and `_maxEntries`. An
     * earlier version computed it just below the sketch and was then zeroed
     * again by the declaration further down, so the option silently did nothing
     * and every test that turned it on failed for the same uninteresting reason.
     *
     * @type {number}
     * @private
     */
    private _windowSize;
    /**
     * MRU end of the admission window, or `null` when the list is shorter than
     * the window. Derived rather than tracked: `_windowOldest()` walks back
     * from the tail, because every attempt that maintained this pointer
     * incrementally got it wrong. The window is *positional*, and a node
     * carrying a correct `inWindow` flag can still be on the wrong side of the
     * boundary.
     * @type {CacheNode|null}
     * @private
     */
    private _windowStart;
    /**
     * MRU end of the probation segment. With `policy: 'slru'` the list is
     * ordered:
     *
     *   head (probation LRU) ... _probationEnd (probation MRU)
     *        -> protected LRU ... tail (protected MRU)
     *
     * New entries are spliced in at the probation/protected boundary and a hit
     * promotes a node to the tail. `null` when the list is empty.
     * @type {CacheNode|null}
     */
    _probationEnd: CacheNode | null;
    _inflightPromises: Map<any, any>;
    _defaultAsyncTimeout: number;
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
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
     * Compute and validate a weight for a value.
     * If `explicitWeight` is provided it is normalized and returned.
     * Otherwise `this.weightFn` is invoked safely and any thrown error
     * or non-finite return value results in a weight of `0`.
     * @private
     * @param {*} value
     * @param {number|null|undefined} explicitWeight
     * @returns {number}
     */
    private _computeWeight;
    /**
     * Report an internal failure (a throwing user callback, a failing
     * `weightFn`, ...) exactly once, through the configured `onError` handler
     * when present and otherwise to `console.error`.
     *
     * Every catch site in this class funnels through here, so a swallowed
     * failure is consistent and observable rather than invisible in some paths
     * and logged in others.
     *
     * @param {any} err - The thrown value.
     * @param {string} msg - Human-readable context.
     * @returns {void}
     * @private
     */
    private _notifyError;
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
     * @remarks This helper does not modify the `misses` counter; callers should
     * increment `this._misses` when the removal corresponds to a user-facing
     * lookup (for example, `get()`/`getMany()`/`getOrSet()`).
     */
    private _removeExpiredNode;
    /**
     * Fetch a node and validate expiry.
     * @private
     * @param {*} key
     * @param {Object} [options]
     * @param {boolean} [options.ignoreExpiry=false]
     * @param {boolean} [options.countMiss=false]
     * @param {boolean} [options.allowExpired=false] Return an expired node instead
     *   of `null`. Read by `_fetchValidNode` and passed by `getOrSet` when
     *   `staleWhileRevalidate` is on; previously read but never documented, so it
     *   was missing from the declared options type.
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
     * Splice `node` in as the new MRU of the probation segment (SLRU only).
     *
     * The list puts probation at the front and protected behind it, so a new
     * entry goes immediately *before* the protected LRU rather than at the tail.
     * The head-splice case (no probation segment exists yet) is what stops a
     * freshly-emptied cache from growing its probation at the wrong end.
     *
     * @private
     * @param {CacheNode} node
     * @returns {void}
     */
    private _insertIntoProbation;
    /**
     * Unlink a node and update every piece of bookkeeping that depends on it.
     *
     * Four call sites - expiry, eviction, `delete()` and the cleanup sweep -
     * each had their own copy of this sequence, which is exactly the kind of
     * duplication that lets one path drift. The only difference between them is
     * that eviction sweeps must also advance `_evictionCandidate`, hence the
     * flag.
     *
     * @private
     * @param {CacheNode} node - Node to unlink. Must currently be in the list.
     * @param {Object} [options]
     * @param {boolean} [options.advanceEvictionCandidate=false] - Also move the
     *   eviction cursor past the removed node.
     * @returns {CacheNode|null} The node that followed it, now at this position.
     */
    private _unlinkNode;
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
     * The oldest node in the admission window, or `null` when the window is empty.
     *
     * Derived from the tail run of flagged nodes rather than maintained as a
     * pointer, and derived by *following the flag* rather than by walking back a
     * fixed number of steps. Both halves matter:
     *
     * - A pointer has to be updated by every mutation of the list. Every attempt
     *   that maintained one missed a mutation, and produced a counter reading
     *   negative some distance from the splice that caused it.
     * - A fixed walk of `windowSize` steps is only right while the window is
     *   **full**. A challenger that loses arbitration is dropped and the window is
     *   briefly one short, at which point the walk reaches past the boundary into
     *   main space: `main space, k-47, k-6, window` with the window's two
     *   survivors after it, which put a recency bump for `k-6` *behind* a key
     *   inserted fifty sets later and quietly destroyed the recency order of main
     *   space. The window is "the flagged run at the tail" at every fill level,
     *   and that is what this returns.
     *
     * The flag is the source of truth for _membership_ because it is set in
     * exactly one place (admission) and cleared in exactly one (promotion or
     * drop). List consistency against it is checked by `test/powerCache.window.test.js`,
     * which is the half this cannot verify on its own.
     *
     * @private
     * @returns {CacheNode|null}
     */
    private _windowOldest;
    /**
     * The eviction candidate in main space: the entry just below the window.
     *
     * `null` when the window holds the whole list, which is the cold-cache case
     * the note calls out: with no main space there is nothing to compare against,
     * and evicting a node against *itself* would remove it from `_map` and lose
     * it permanently.
     *
     * @private
     * @returns {CacheNode|null}
     */
    private _windowVictim;
    /**
     * Splice an unlinked node in at the MRU end of main space — immediately
     * before the window's oldest entry.
     *
     * This is the *one* splice that may place a node on the main-space side of
     * the boundary, and every path that leaves the window goes through it.
     * Appending to the tail instead is the error three separate implementations
     * made: it puts a main-space node back inside the window region, the region
     * and the counter stop describing the same set of nodes, and the visible
     * symptom is a counter bug some distance from its cause.
     *
     * Falls back to the tail when the window is empty (main space then runs to
     * the end of the list) and to a head fix when there is no main space at all.
     *
     * @private
     * @param {CacheNode} node - An unlinked node. Its links are overwritten.
     * @returns {void}
     */
    private _insertAtMainSpaceMrU;
    /**
     * Move a node out of the window and into main space, in front of the window.
     *
     * @private
     * @param {CacheNode} node - A linked window node.
     * @returns {void}
     */
    private _promoteFromWindow;
    /**
     * Evict one node, reporting it and returning it to the node pool.
     *
     * Single-node sibling of `_evictIfNeeded`, for the paths that displace a
     * specific victim rather than sweeping. Sharing the unlink/report/free
     * sequence is what keeps `onEvict` firing on every path — a window eviction
     * that skipped the callback would be invisible to every user cleanup and to
     * the pool's own node accounting.
     *
     * @private
     * @param {CacheNode} node
     * @returns {void}
     */
    private _evictNode;
    /**
     * Admit a new key into the window, then arbitrate the window's oldest entry.
     *
     * Called after a new key has been appended at the tail. Once the window is
     * full, its oldest entry is the challenger: it either takes a place in main
     * space or is dropped, and which one is the only place the sketch arbitrates.
     *
     * Two rules here are not in the W-TinyLFU *description* and both were found
     * by attempting it (see `design/0001-tinylfu-admission-window.md`):
     *
     * - **The challenger wins ties.** A tie means "no evidence either is better",
     *   and discarding the challenger discards the only evidence the filter has.
     *   Refusing ties is what made a fill-then-read caller lose every key written
     *   after the first few, because they all tie at estimate 1.
     * - **Only arbitrate at capacity.** While main space has room the filter has
     *   nothing to protect and a comparison has no signal — every fresh key sits
     *   at estimate 1, so every comparison is a tie and the churn evicts the
     *   entry the previous `set` just promoted. Measured: a 40-key warm ended with
     *   5 entries instead of 40. Caffeine's `admit` makes the same check.
     *
     * `previousSize` is the count **before** the arrival, and it has to be. A
     * cache filled to exactly `maxEntries` has been full the whole time the last
     * key was arriving; testing the count *after* the insert makes the final key
     * of every fill contend with a main-space victim it should have been promoted
     * past, which drops it. That is a 40-key warm ending at 39 — one key short,
     * no error, and invisible unless the test checks the count.
     *
     * @private
     * @param {number} previousSize - `this._map.size` before this arrival.
     * @returns {void}
     */
    private _arbitrateWindow;
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
     * @returns {Map<string, *>} One entry per resolved key, in input order.
     */
    getMany(keys: Iterable<any>, { ignoreExpiry }?: {
        ignoreExpiry?: boolean | undefined;
    }): Map<string, any>;
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
     * @param {number} [options.timeout] Per-call override of the cache's `defaultAsyncTimeout`, in ms.
     * @returns {Promise<*>}
     */
    getOrSetAsync(key: any, asyncFactory: Function, { ttl, weight, staleWhileRevalidate, timeout }?: {
        ttl?: number | undefined;
        weight?: number | undefined;
        staleWhileRevalidate?: boolean | undefined;
        timeout?: number | undefined;
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
     * @returns {boolean}
     */
    hasEqual(key: any, value: any, options?: {
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
     * @param {number|Object} [intervalOrOptions] - Cleanup interval in ms, or an
     *   options object `{ interval, maxCleanupPerTick }`. The nested tags were
     *   removed because a qualified `@param` is only valid when the parent is a
     *   bare `{Object}`; against `number|Object` it is rejected with TS8032.
     * @returns {void}
     */
    startCleanup(intervalOrOptions?: number | Object): void;
    /**
     * Stop periodic cleanup.
     * @returns {void}
     */
    stopCleanup(): void;
    /**
     * Synchronous disposal hook (TC39 Explicit Resource Management).
     * Stops any background cleanup and clears the cache.
     */
    /**
     * Named alias for the `Symbol.dispose` implementation, so callers who do not
     * want to reach for the symbol still have something to call.
     * @returns {void}
     */
    dispose(): void;
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
    [Symbol.dispose](): void;
    /**
     * Asynchronous disposal hook. Provided for symmetry with `using`/`await using`.
     * Cache cleanup is synchronous so this simply performs the same actions and
     * returns a resolved Promise for await compatibility.
     */
    [Symbol.asyncDispose](): Promise<void>;
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
 * Usage (constructor returns a `PowerMemoizer` instance; when a function is supplied
 * the instance creates a memoized wrapper and exposes a convenience `run()` alias):
 * const fetcher = async (id) => await fetchData(id)
 * const pm = new PowerMemoizer(fetcher, { cacheOptions: { defaultTTL: 1000 } })
 * // call the memoized function via the convenience alias
 * await pm.run(1)
 *
 * @class PowerMemoizer
 * @public
 */
export class PowerMemoizer {
    /**
     * Create a PowerMemoizer.
     * @param {Function} [fn] - Optional function to memoize immediately.
     * @param {PowerMemoizerOptions} [options]
     */
    constructor(fn?: Function, options?: PowerMemoizerOptions);
    keyResolver: (...arg0: any[]) => string;
    cache: PowerCache;
    _inflight: Map<any, any>;
    _defaultMemoizeOptions: {};
    run: (...args: any[]) => any;
    _originalFn: Function | null;
    _receiverIds: WeakMap<WeakKey, any>;
    _nextReceiverId: number;
    _fnWrapper: import("./jsdoc-types.js").MemoizedFunction<Function> | undefined;
    /**
     * Wrap a function with memoization.
     * @private
     * @param {Function} fn - Function to memoize. May return a Promise.
     * @param {Object} [options]
     * @param {number} [options.ttl] - Per-entry TTL in ms (overrides cache default)
     * @param {number} [options.weight] - Optional explicit weight for the entry
     * @returns {Function} Memoized function
     */
    /**
     * Build a cache key that includes the receiver's identity, so memoizing a
     * method keeps one entry per object instead of collapsing every caller's
     * result into a single shared entry.
     *
     * Object and function receivers get a monotonic id from a per-instance
     * `WeakMap`. Primitive receivers (`memoized.call(5, x)`) fall back to their
     * string form, which is still correct because the same primitive receiver
     * necessarily has the same state.
     *
     * @param {any} receiver - The `this` value the wrapper was called with.
     * @param {any[]} args - The call arguments.
     * @returns {string} Cache key scoped to `receiver`.
     * @private
     */
    private _receiverKey;
    /**
     * Wrap `fn` so every call goes through this memoizer's cache.
     *
     * Documented because it is a real (private) seam: `memoize()` normalises the
     * options before calling it, and the declaration had no JSDoc at all, so the
     * emitted signature was `{ ttl, weight }?: {}` - a destructuring pattern typed
     * as the empty object, which is not assignable from anything. That is a
     * declaration error in the published `.d.ts`, not a runtime one.
     *
     * @param {Function} fn - Function to wrap.
     * @param {F} fn - Function to wrap.
     * @param {Object} [options] - Per-wrapper overrides merged over the defaults.
     * @param {number} [options.ttl]
     * @param {number} [options.weight]
     * @returns {import('./jsdoc-types.js').MemoizedFunction<F>} The memoized wrapper.
     * @template {Function} F
     * @private
     */
    private _memoize;
    /**
     * Public API to memoize an arbitrary function using this PowerMemoizer instance's cache.
     * Mirrors the behavior used by the constructor when a function is supplied —
     * returns a callable memoized function with helpers attached (`get`, `has`, `delete`, `clear`, `stats`, `cache`).
     * @param {F} fn - Function to memoize
     * @param {Object} [options] - Optional per-wrapper options { ttl, weight }
     * @returns {import('./jsdoc-types.js').MemoizedFunction<F>} The memoized
     *   wrapper, callable like `fn` and
     *   carrying `get`/`has`/`delete`/`clear`/`stats`/`cache`/`original`.
     * @template {Function} F
     */
    memoize<F extends Function>(fn: F, options?: Object): import("./jsdoc-types.js").MemoizedFunction<F>;
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
    /**
     * Named alias for the `Symbol.dispose` implementation, so callers who do not
     * want to reach for the symbol still have something to call.
     * @returns {void}
     */
    dispose(): void;
    /**
     * Release the underlying cache.
     *
     * `PowerMemoizer` owns no state of its own - it delegates to a `PowerCache`
     * - so disposal forwards to it. The inner cache is not replaced, so a
     * disposed memoizer's `cache` reference stays readable.
     *
     * @returns {void}
     */
    [Symbol.dispose](): void;
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
 * @public
 */
export class PowerTimedCache {
    /**
     * @param {number} ttl - Default TTL in milliseconds for entries.
     * @param {PowerTimedCacheOptions} [options]
     */
    constructor(ttl: number, { maxEntries, interval, maxCleanupPerTick, cacheOptions }?: PowerTimedCacheOptions);
    cache: PowerCache;
    get(key: any): any;
    set(key: any, value: any, options?: {}): false | PowerCache;
    has(key: any, options?: {}): boolean;
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
    startCleanup(intervalOrOptions?: undefined): void;
    stopCleanup(): void;
    get size(): number;
    get hitRate(): number;
    entries(order: any): IterableIterator<[any, any]>;
    keys(order: any): Generator<any, void, unknown>;
    values(order: any): Generator<any, void, unknown>;
    /**
     * Named alias for the `Symbol.dispose` implementation, so callers who
     * do not want to reach for the symbol still have something to call.
     * @returns {void}
     */
    dispose(): void;
    [Symbol.dispose](): void;
    [Symbol.asyncDispose](): Promise<void>;
}
export type CacheNode = import("./jsdoc-types.js").CacheNode;
export type PowerCacheOptions = import("./jsdoc-types.js").PowerCacheOptions;
export type PowerMemoizerOptions = import("./jsdoc-types.js").PowerMemoizerOptions;
export type PowerTimedCacheOptions = import("./jsdoc-types.js").PowerTimedCacheOptions;
