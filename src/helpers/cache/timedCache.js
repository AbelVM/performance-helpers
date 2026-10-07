import { PowerCache } from './core.js';
import { POWER_CACHE_OPTIONS } from './core.js';
import { assertKnownOptions } from '../../utils/options.js';

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
  constructor(ttl, { maxEntries, interval, maxCleanupPerTick, cacheOptions = {} } = {}) {
    // CACHE-013: this allowlist was `['ttl', 'weight', 'cacheOptions']` — which is
    // `PowerMemoizer`'s list minus `keyResolver`, so a copy from the wrong class
    // rather than a decision. It left 21 of the inner cache's options unreachable,
    // and two of those made the delegated methods inert:
    //
    // - `maxWeight` / `rejectOversized` — a *weighted* TTL cache was inexpressible.
    // - `staleTtl` — `_staleServable` reads only `staleTtl`, which defaults to 0, and
    //   `now <= expiresAt + 0` is false for every expired entry. So the
    //   `staleWhileRevalidate` option `getOrSet` accepts was **silently a no-op**: a
    //   caller passing it got ordinary expiry and no error.
    //
    // **Derived, not restated.** The first version of this fix hand-copied the inner
    // list and got it wrong in four places while omitting `seed`, so the wrapper
    // advertised options the cache behind it rejects. One list, filtered.
    //
    // `defaultTTL` is the one omission, and deliberately: this constructor's `ttl` is
    // the default TTL by construction, assigned after the copy below, so accepting it
    // would be an option that is accepted and ignored — refused instead, because the
    // pattern this review treats as a defect is a documented option that does nothing.
    // Nothing could pass it before this change, so refusing it breaks no caller.
    assertKnownOptions(
      cacheOptions,
      POWER_CACHE_OPTIONS.filter((option) => option !== 'defaultTTL'),
      'PowerTimedCache'
    );
    if (!Number.isFinite(+ttl) || ttl <= 0) throw new TypeError('ttl must be a positive number');
    const cfg = Object.assign({}, cacheOptions);
    if (maxEntries !== undefined) cfg.maxEntries = maxEntries;
    cfg.defaultTTL = +ttl;
    this.cache = new PowerCache(cfg);
    // auto-start cleanup; if caller supplied interval options, forward them
    if (interval !== undefined || maxCleanupPerTick !== undefined) {
      this.cache.startCleanup({ interval, maxCleanupPerTick });
    } else {
      this.cache.startCleanup();
    }
  }

  // Delegate commonly used methods to the underlying PowerCache
  /**
   * @param {any} key
   * @returns {any}
   */
  get(key) {
    return this.cache.get(key);
  }
  // These forward to the inner `PowerCache` and were declared with required
  // parameters, so `timed.set(k, v)` - two arguments, which is all the method
  // needs - failed to type-check with "Expected 3 arguments, but got 2".
  //
  // The `options` parameter is declared for the same reason: the inner methods
  // take `{ttl, weight}`, and an undeclared third parameter is published as
  // `options?: {}`, which type-checks anything and tells the caller nothing.
  /**
   * @param {any} key
   * @param {any} value
   * @param {{ttl?: number, weight?: number}} [options] Per-entry TTL in ms and
   *   weight. Both are ignored when this instance was constructed with a
   *   non-null TTL — the constructor's TTL wins.
   * @returns {false|PowerTimedCache}
   */
  set(key, value, options = {}) {
    // CACHE-013: the inner `set` returns `this` — the **`PowerCache`**, not this
    // wrapper — and returning it unchanged made the published type a lie: the JSDoc
    // said `false|PowerTimedCache`, so `timed.set('a', 1).set('b', 2)` type-checked as
    // a `PowerTimedCache` chain and then ran on the inner object, where any
    // TimedCache-only behaviour would be absent. The inner result is truthy on
    // success and exactly `false` on the oversize refusal, so one conditional
    // restores both the type and the chain.
    return this.cache.set(key, value, options) ? this : false;
  }
  /**
   * @param {any} key
   * @param {{allowStale?: boolean, staleTtl?: number}} [options] `allowStale`
   *   returns an expired entry and refreshes in the background, bounded by
   *   `staleTtl` — see the `PowerCache` guide, because an unbounded stale window
   *   serves a value of any age.
   * @returns {boolean}
   */
  has(key, options = {}) {
    return this.cache.has(key, options);
  }
  delete(key) {
    return this.cache.delete(key);
  }
  clear() {
    return this.cache.clear();
  }
  stats() {
    return this.cache.stats();
  }

  // CACHE-013: the rest of the `PowerCache` surface, delegated.
  //
  // This class was already a thin wrapper forwarding fifteen methods, so the line
  // it drew was arbitrary rather than designed: `peek`, `touch`, `resize`,
  // `getOrSet`, `getOrSetAsync`, `setMany`, `getMany` and `hasEqual` all existed on
  // the inner cache and not here. The row's own complaint — "a TTL cache with no
  // `touch()` is a surprise" — is the whole case, and the alternative the row also
  // offered, *documenting the subset*, costs **more** surface rather than less: eight
  // documented absences on a class whose entire purpose is to be a `PowerCache` with
  // a constructor-supplied TTL.
  //
  // Each is a bare forward. **None of them needs TTL-specific logic**, which is the
  // test that decided delegation over reimplementation: `touch` forwards its optional
  // per-call TTL, so a wrapper that dropped it would silently give every entry the
  // constructor's TTL instead — a bug that would not throw, only expire things at the
  // wrong time.
  //
  // Per-entry `{ttl}` is ignored wherever the instance was constructed with a
  // non-null TTL, because `cfg.defaultTTL` is what the inner cache applies. That is
  // pre-existing `set()` behaviour, now stated on the methods that also accept one.

  /**
   * Read a value **without** promoting it to most-recently-used, and without
   * counting a hit. For when the value matters but the access pattern does not.
   * @param {*} key
   * @returns {*|undefined}
   */
  peek(key) {
    return this.cache.peek(key);
  }

  /**
   * Extend (or shorten) one entry's TTL without reading or writing its value.
   * @param {*} key
   * @param {number} [ttl] Per-call TTL in ms. `null`/`Infinity` disables expiry.
   * @returns {boolean} True if the entry existed and had not expired.
   */
  touch(key, ttl = undefined) {
    return this.cache.touch(key, ttl);
  }

  /**
   * Change the capacity of a live cache. Takes effect on the next insertion.
   * @param {Object} options
   * @param {number} [options.maxEntries]
   * @param {number} [options.maxWeight]
   */
  resize({ maxEntries, maxWeight } = {}) {
    return this.cache.resize({ maxEntries, maxWeight });
  }

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
  getOrSet(key, factory, options = {}) {
    return this.cache.getOrSet(key, factory, options);
  }

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
  getOrSetAsync(key, asyncFactory, options = {}) {
    return this.cache.getOrSetAsync(key, asyncFactory, options);
  }

  /**
   * Insert many entries in one pass.
   * @param {Iterable<[*,*]>} entries
   * @param {Object} [options]
   * @param {number} [options.ttl] Ignored when this instance has a constructor TTL.
   * @param {number} [options.weight]
   * @returns {PowerTimedCache} `this`, so a batch insert can be chained — **not** the
   *   inner `PowerCache`, which is what CACHE-013 had to correct in `set()`.
   */
  setMany(entries, { ttl = undefined, weight = undefined } = {}) {
    this.cache.setMany(entries, { ttl, weight });
    return this;
  }

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
  getMany(keys, { ignoreExpiry = false } = {}) {
    return this.cache.getMany(keys, { ignoreExpiry });
  }

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
  hasEqual(key, value, options = {}) {
    return this.cache.hasEqual(key, value, options);
  }

  /**
   * Alias for {@link stats}.
   *
   * See `guides/stats-naming.md` for why both spellings exist and why this
   * method is written out per class.
   */
  getStats() {
    return this.stats();
  }
  startCleanup(intervalOrOptions = undefined) {
    return this.cache.startCleanup(intervalOrOptions);
  }
  stopCleanup() {
    return this.cache.stopCleanup();
  }
  get size() {
    return this.cache.size;
  }
  get hitRate() {
    return this.cache.hitRate;
  }
  /**
   * @param {'LRU'|'MRU'} [order='MRU'] Iteration order, forwarded verbatim to
   *   the inner `PowerCache`. Declared here rather than left implicit because an
   *   undeclared parameter is published as an implicit `any`, which accepts a
   *   typo like `'lru'` that the inner method would then reject at runtime.
   * @returns {IterableIterator<[any, any]>}
   */
  entries(order) {
    return this.cache.entries(order);
  }
  /**
   * @param {'LRU'|'MRU'} [order='MRU']
   * @returns {IterableIterator<any>}
   */
  keys(order) {
    return this.cache.keys(order);
  }
  /**
   * @param {'LRU'|'MRU'} [order='MRU']
   * @returns {IterableIterator<any>}
   */
  values(order) {
    return this.cache.values(order);
  }
  /**
   * Named alias for the `Symbol.dispose` implementation, so callers who
   * do not want to reach for the symbol still have something to call.
   * @returns {void}
   */
  dispose() {
    this[Symbol.dispose]();
  }

  [Symbol.dispose]() {
    if (typeof this.cache?.[Symbol.dispose] === 'function') return this.cache[Symbol.dispose]();
  }
  async [Symbol.asyncDispose]() {
    if (typeof this.cache?.[Symbol.asyncDispose] === 'function')
      return this.cache[Symbol.asyncDispose]();
    return;
  }
}
