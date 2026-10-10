/**
 * @typedef {import('../jsdoc-types.js').PowerTimedCacheOptions} PowerTimedCacheOptions
 */
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
    /**
     * @param {any} key
     * @returns {any}
     */
    get(key: any): any;
    /**
     * @param {any} key
     * @param {any} value
     * @param {{ttl?: number, weight?: number}} [options] Per-entry TTL in ms and
     *   weight. Both are ignored when this instance was constructed with a
     *   non-null TTL — the constructor's TTL wins.
     * @returns {false|PowerTimedCache}
     */
    set(key: any, value: any, options?: {
        ttl?: number;
        weight?: number;
    }): false | PowerTimedCache;
    /**
     * @param {any} key
     * @param {{allowStale?: boolean, staleTtl?: number}} [options] `allowStale`
     *   returns an expired entry and refreshes in the background, bounded by
     *   `staleTtl` — see the `PowerCache` guide, because an unbounded stale window
     *   serves a value of any age.
     * @returns {boolean}
     */
    has(key: any, options?: {
        allowStale?: boolean;
        staleTtl?: number;
    }): boolean;
    delete(key: any): boolean;
    clear(): void;
    stats(): {
        size: number;
        weight: number;
        hits: number;
        misses: number;
        staleServes: number;
        evictions: number;
        expirations: number;
        rejected: number;
        rejectedAdmission: number;
        weightErrors: number;
        refreshesSkipped: number;
        refreshesFailed: number;
        refreshesAborted: number;
        poolSize: number;
        ghostSize: number;
    };
    /**
     * Read a value **without** promoting it to most-recently-used, and without
     * counting a hit. For when the value matters but the access pattern does not.
     * @param {*} key
     * @returns {*|undefined}
     */
    peek(key: any): any | undefined;
    /**
     * Extend (or shorten) one entry's TTL without reading or writing its value.
     * @param {*} key
     * @param {number} [ttl] Per-call TTL in ms. `null`/`Infinity` disables expiry.
     * @returns {boolean} True if the entry existed and had not expired.
     */
    touch(key: any, ttl?: number): boolean;
    /**
     * Change the capacity of a live cache. Takes effect on the next insertion.
     * @param {Object} options
     * @param {number} [options.maxEntries]
     * @param {number} [options.maxWeight]
     */
    resize({ maxEntries, maxWeight }?: {
        maxEntries?: number | undefined;
        maxWeight?: number | undefined;
    }): void;
    /**
     * Read through to a factory on a miss. The common idiom, and previously absent
     * here — so a TTL cache could not do the one thing callers reach a cache for.
     * @param {*} key
     * @param {Function|*} factory - A function producing the value, or the value itself.
     * @param {Object} [options]
     * @param {number} [options.ttl] Ignored when this instance has a constructor TTL.
     * @param {number} [options.weight]
     * @param {boolean} [options.staleWhileRevalidate=false] Return an expired value
     *   immediately and refresh in the background.
     * @returns {*|Promise<*>}
     */
    getOrSet(key: any, factory: Function | any, options?: {
        ttl?: number | undefined;
        weight?: number | undefined;
        staleWhileRevalidate?: boolean | undefined;
    }): any | Promise<any>;
    /**
     * `getOrSet` with an async factory. See the `PowerCache` guide for the
     * single-flight and `defaultAsyncTimeout` semantics.
     * @param {*} key
     * @param {Function} asyncFactory - Returns a promise, or a value.
     * @param {Object} [options]
     * @param {number} [options.ttl] Ignored when this instance has a constructor TTL.
     * @param {number} [options.weight]
     * @param {boolean} [options.staleWhileRevalidate=false]
     * @param {number} [options.timeout] Per-call override of `defaultAsyncTimeout`.
     * @returns {Promise<*>}
     */
    getOrSetAsync(key: any, asyncFactory: Function, options?: {
        ttl?: number | undefined;
        weight?: number | undefined;
        staleWhileRevalidate?: boolean | undefined;
        timeout?: number | undefined;
    }): Promise<any>;
    /**
     * Insert many entries in one pass.
     * @param {Iterable<[*,*]>} entries
     * @param {Object} [options]
     * @param {number} [options.ttl] Ignored when this instance has a constructor TTL.
     * @param {number} [options.weight]
     * @returns {PowerTimedCache} `this`, so a batch insert can be chained — **not** the
     *   inner `PowerCache`, which is what CACHE-013 had to correct in `set()`.
     */
    setMany(entries: Iterable<[any, any]>, { ttl, weight }?: {
        ttl?: number | undefined;
        weight?: number | undefined;
    }): PowerTimedCache;
    /**
     * Read many keys in one pass. **Misses and expired entries are omitted**, not
     * returned as `undefined` — the inner loop does `if (!node) continue` — so the
     * result is smaller than the input and its keys are the resolved ones, in input
     * order. Use `has()` per key if you need to align positions.
     * @param {Iterable<*>} keys
     * @param {Object} [options]
     * @param {boolean} [options.ignoreExpiry=false]
     * @returns {Map<string, *>} The resolved entries, in input order.
     */
    getMany(keys: Iterable<any>, { ignoreExpiry }?: {
        ignoreExpiry?: boolean | undefined;
    }): Map<string, any>;
    /**
     * Test a value by **deep** comparison without promoting the entry to
     * most-recently-used. Not a reference test: after the reference and primitive
     * fast paths it falls through to a `deepEqual` walk, so a stored `{deep: 1}` does
     * match an incoming `{deep: 1}`. `compareFn` and `maxNodes` bound the walk.
     *
     * The one quirk worth naming, because it is inherited by being the same code
     * rather than reimplemented: it does **not** touch recency, so a `hasEqual` sweep
     * leaves the eviction order untouched.
     * @param {*} key
     * @param {*} value
     * @param {{ignoreExpiry?: boolean, maxNodes?: number, compareFn?: function(any, any): boolean}} [options]
     * @returns {boolean}
     */
    hasEqual(key: any, value: any, options?: {
        ignoreExpiry?: boolean;
        maxNodes?: number;
        compareFn?: (arg0: any, arg1: any) => boolean;
    }): boolean;
    /**
     * Alias for {@link stats}.
     *
     * See `guides/stats-naming.md` for why both spellings exist and why this
     * method is written out per class.
     */
    getStats(): {
        size: number;
        weight: number;
        hits: number;
        misses: number;
        staleServes: number;
        evictions: number;
        expirations: number;
        rejected: number;
        rejectedAdmission: number;
        weightErrors: number;
        refreshesSkipped: number;
        refreshesFailed: number;
        refreshesAborted: number;
        poolSize: number;
        ghostSize: number;
    };
    startCleanup(intervalOrOptions?: undefined): void;
    stopCleanup(): void;
    get size(): number;
    get hitRate(): number;
    /**
     * @param {'LRU'|'MRU'} [order='MRU'] Iteration order, forwarded verbatim to
     *   the inner `PowerCache`. Declared here rather than left implicit because an
     *   undeclared parameter is published as an implicit `any`, which accepts a
     *   typo like `'lru'` that the inner method would then reject at runtime.
     * @returns {IterableIterator<[any, any]>}
     */
    entries(order?: "LRU" | "MRU"): IterableIterator<[any, any]>;
    /**
     * @param {'LRU'|'MRU'} [order='MRU']
     * @returns {IterableIterator<any>}
     */
    keys(order?: "LRU" | "MRU"): IterableIterator<any>;
    /**
     * @param {'LRU'|'MRU'} [order='MRU']
     * @returns {IterableIterator<any>}
     */
    values(order?: "LRU" | "MRU"): IterableIterator<any>;
    /**
     * Named alias for the `Symbol.dispose` implementation, so callers who
     * do not want to reach for the symbol still have something to call.
     * @returns {void}
     */
    dispose(): void;
    [Symbol.dispose](): void;
    [Symbol.asyncDispose](): Promise<void>;
}
export type PowerTimedCacheOptions = import("../jsdoc-types.js").PowerTimedCacheOptions;
import { PowerCache } from './core.js';
