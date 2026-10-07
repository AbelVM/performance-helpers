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
 * @param {...any} args
 * @public
 */
export function simpleArgsKey(...args: any[]): string;
export class PowerMemoizer {
    /**
     * Create a PowerMemoizer.
     * @param {Function} [fn] - Optional function to memoize immediately.
     * @param {PowerMemoizerOptions} [options]
     */
    constructor(fn?: Function, options?: PowerMemoizerOptions);
    keyResolver: any;
    cache: PowerCache;
    _inflight: Map<any, any>;
    /** @type {{ttl?: number, weight?: number}} */
    _defaultMemoizeOptions: {
        ttl?: number;
        weight?: number;
    };
    run: (...args: any[]) => any;
    _originalFn: Function | null;
    _receiverIds: WeakMap<WeakKey, any>;
    _nextReceiverId: number;
    _fnWrapper: import("../jsdoc-types.js").MemoizedFunction<Function> | undefined;
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
     * @param {F} fn - Function to wrap.
     * @param {{ttl?: number, weight?: number}} [options] Per-wrapper overrides merged
     *   over the defaults. Documented here for the reader; the parameter is
     *   destructured in the signature, so it is the inline cast on the default that
     *   actually types it - a `@param` tag cannot bind to it.
     * @returns {import('../jsdoc-types.js').MemoizedFunction<F>} The memoized wrapper.
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
     * @returns {import('../jsdoc-types.js').MemoizedFunction<F>} The memoized
     *   wrapper, callable like `fn` and
     *   carrying `get`/`has`/`delete`/`clear`/`stats`/`cache`/`original`.
     * @template {Function} F
     */
    memoize<F extends Function>(fn: F, options?: Object): import("../jsdoc-types.js").MemoizedFunction<F>;
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
     * Key an attached helper should use, given the helper's own receiver.
     *
     * The helpers are the only way to reach a **method**-memoized entry, and they
     * used to be arrow functions, which discarded their receiver entirely. So
     * `memo.call(obj, 10)` stored under `r1:10` while `memo.get(10)` looked up
     * `10`: the entry existed, was invisible, and could not be invalidated by any
     * of `get`/`has`/`delete`. They are ordinary functions now, and this is where
     * the receiver is turned back into a key.
     *
     * Calling a helper plainly — `memo.get(10)` — leaves the memoized function as
     * the receiver, and that must resolve the **unscoped** key, because a plain
     * `memo(10)` call is what stored it. So the guide's documented
     * `get(...args)` keeps working unchanged, and
     * `memo.get.call(obj, 10)` reaches the entry `memo.call(obj, 10)` stored.
     *
     * A `null`/absent receiver is the detached-helper case (`const g = memo.get`),
     * which resolved the unscoped key before this change and still does.
     *
     * @param {Function} memoizedFn - The wrapper the helper is attached to.
     * @param {any} receiver - The helper's `this`.
     * @param {any[]} args
     * @returns {string}
     * @private
     */
    private _scopedKey;
    /**
     * @param {string} key
     * @returns {*|undefined}
     * @private
     */
    private _lookup;
    /**
     * @param {string} key
     * @returns {boolean}
     * @private
     */
    private _evict;
    /**
     * @param {Function} memoizedFn
     * @param {any} receiver
     * @param {any[]} args
     * @returns {*|undefined}
     * @private
     */
    private _getFor;
    /**
     * @param {Function} memoizedFn
     * @param {any} receiver
     * @param {any[]} args
     * @returns {boolean}
     * @private
     */
    private _hasFor;
    /**
     * @param {Function} memoizedFn
     * @param {any} receiver
     * @param {any[]} args
     * @returns {boolean}
     * @private
     */
    private _deleteFor;
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
     * Alias for {@link stats}.
     *
     * See `guides/stats-naming.md` for why both spellings exist and why this
     * method is written out per class.
     */
    getStats(): Object;
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
import { PowerCache } from './core.js';
