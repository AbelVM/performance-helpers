import { assertKnownOptions } from '../../utils/options.js';
import { PowerCache } from './core.js';
import { isError } from '../../utils/errors.js';

export class PowerMemoizer {
  /**
   * Create a PowerMemoizer.
   * @param {Function} [fn] - Optional function to memoize immediately.
   * @param {PowerMemoizerOptions} [options]
   */
  constructor(fn, options = {}) {
    assertKnownOptions(options, ['keyResolver', 'cacheOptions', 'ttl', 'weight'], 'PowerMemoizer');
    assertKnownOptions(
      options,
      [
        'admission',
        'allowStale',
        'cacheOptions',
        'defaultAsyncTimeout',
        'defaultTTL',
        'fetchMethod',
        'initialPoolSize',
        'keyResolver',
        'maxCleanupPerTick',
        'maxEntries',
        'maxInflightRefreshes',
        'maxPoolSize',
        'maxWeight',
        'now',
        'observability',
        'onError',
        'onEvict',
        'onExpire',
        'policy',
        'rejectOversized',
        'staleTtl',
        'ttl',
        'weight',
        'weightFn',
        'windowSize',
      ],
      'PowerCache'
    );
    const { keyResolver = simpleArgsKey, cacheOptions = {}, ttl, weight } = options;
    // `simpleArgsKey` is the default rather than `JSON.stringify` (PERF-005, an
    // earlier review's memoizer-key row — NOT `review.md`'s PERF-005, which is a
    // `powerMessageCodec` item about `o2u8` returning a non-string). It
    // is ~35% cheaper for the scalar arguments memoizers are actually called
    // with, and it falls back to `JSON.stringify` the moment it meets a
    // non-scalar, so behaviour is unchanged for anything it cannot encode
    // cheaply. The cache key *format* changes, which is a 2.0 break: a
    // memoizer's `.cache` is in-memory and is not a persisted format, but a
    // caller reading keys - in a test, or in a debug dump - will see it.
    this.keyResolver = typeof keyResolver === 'function' ? keyResolver : simpleArgsKey;
    this.cache = new PowerCache(cacheOptions);
    // track inflight Promises to deduplicate concurrent calls
    this._inflight = new Map();
    /** @type {{ttl?: number, weight?: number}} */
    this._defaultMemoizeOptions = {};
    if (ttl !== undefined) this._defaultMemoizeOptions.ttl = ttl;
    if (weight !== undefined) this._defaultMemoizeOptions.weight = weight;

    // Default run behavior: when no function is supplied the instance will
    // throw if `run()` is invoked. Callers should use `memoize(fn)` to obtain
    // a memoized wrapper for a function.
    this.run = () => {
      throw new TypeError(
        'No function supplied to PowerMemoizer; call memoize(fn) to create a memoized wrapper.'
      );
    };
    this._originalFn = null;
    // Per-instance receiver identity table used to build cache keys for
    // memoized *methods* (see `_receiverKey`). WeakMap so a receiver that
    // becomes unreachable cannot leak an entry.
    this._receiverIds = new WeakMap();
    this._nextReceiverId = 0;

    // If a function was provided at construction time, keep it as the
    // original function and create a memoized wrapper available via
    // `memoize(fn)` and the convenience `run()` alias. The constructor
    // always returns the instance (never a bare function).
    if (typeof fn === 'function') {
      this._originalFn = fn;
      try {
        // Create and cache a memoized wrapper using the instance defaults.
        this._fnWrapper = this.memoize(fn);
        // Provide a simple convenience method to invoke the memoized wrapper
        // directly on the instance for callers that previously relied on
        // constructor-returned functions.
        /** @param {...any} args */
        this.run = (...args) => {
          if (typeof this._fnWrapper === 'function') return this._fnWrapper(...args);
        };
      } catch (err) {
        // Ignore failures to create the wrapper; callers can still call
        // `memoize(fn)` explicitly.
      }
    }
  }

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
  _receiverKey(receiver, args) {
    let id;
    if (receiver !== null && (typeof receiver === 'object' || typeof receiver === 'function')) {
      id = this._receiverIds.get(receiver);
      if (id === undefined) {
        id = this._nextReceiverId++;
        this._receiverIds.set(receiver, id);
      }
    } else {
      id = `p${String(receiver)}`;
    }
    return `r${id}:${this.keyResolver(...args)}`;
  }

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
  _memoize(
    fn,
    // The cast is what types `ttl`/`weight`. A JSDoc `@param [options]` cannot:
    // this parameter is destructured in the signature, so there is no parameter
    // *named* options for the tag to bind to and TS rejects it with TS8024. The
    // qualified `@param {number} [options.ttl]` tags above are inert for the same
    // reason, which is why reading `ttl` off this used to be an error.
    { ttl, weight } = /** @type {{ttl?: number, weight?: number}} */ ({})
  ) {
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');
    const self = this;
    // `this` is annotated because the wrapper deliberately inspects its receiver,
    // and an unannotated one in a bare function expression is implicitly `any` -
    // which would make the null check below untypeable and hide the very case it
    // exists for.
    //
    // `@this` rather than a cast on the rest parameter: a rest-parameter cast
    // types `args` only, and leaves `this` implicitly `any` in a bare function
    // expression - which is exactly the value the receiver logic below reads.
    // Typed `object|null` because a plain `fn(1)` call has no meaningful
    // receiver and the wrapper falls back to the argument-only key space.
    /**
     * @this {object|null}
     * @this {object|null}
     * @param {...any} args
     */
    return function memoized(...args) {
      // Memoizing a *method* must not lose the receiver. The wrapper is a
      // plain `function` (not an arrow) precisely so `this` is observable.
      // Two things follow from that:
      //   1. `this` has to be forwarded to `fn`, and
      //   2. `this` has to be part of the cache key, or `objA.m(1)` and
      //      `objB.m(1)` would share one entry and return each other's value.
      // A plain `fn(1)` call (no meaningful receiver) keeps the original key
      // space so existing cache entries and key expectations are unchanged.
      const receiver = this === undefined || this === null ? null : this;
      const key = receiver === null ? self.keyResolver(...args) : self._receiverKey(receiver, args);
      // One lookup, not two. `cache.has(key)` followed by `cache.get(key)` is
      // the obvious way to tell "absent" from "cached `undefined`", and it
      // costs a full extra lookup on every single call - measured at 0.25 us for
      // the pair against 0.125 us for one, on a 0.41 us call. `_fetchValidNode`
      // already does the expiry check and returns the node or null, so the node's
      // existence is the answer and the value comes off it.
      const node = self.cache._fetchValidNode(key);
      if (node !== null) return node.value;
      // if there is an inflight Promise, return it to dedupe
      if (self._inflight.has(key)) return self._inflight.get(key);

      const res = receiver === null ? fn(...args) : fn.apply(receiver, args);
      // Promise-like
      if (typeof res?.then === 'function') {
        // Wrap the incoming thenable/promise in an async wrapper so we can
        // register the inflight marker before the original thenable may
        // synchronously invoke callbacks (some thenables call handlers
        // synchronously). The wrapper ensures we always delete the inflight
        // marker exactly once after settlement and avoids races where a
        // deletion could occur before the inflight was recorded.
        const p = (async () => {
          try {
            const value = await res;
            try {
              self.cache.set(key, value, { ttl, weight });
            } catch (err) {
              /* swallow cache errors */
            }
            return value;
          } finally {
            // Ensure inflight marker is removed regardless of resolution
            // or rejection.
            self._inflight.delete(key);
          }
        })();
        self._inflight.set(key, p);
        return p;
      }

      // synchronous result — cache and return
      self.cache.set(key, res, { ttl, weight });
      return res;
    };
  }

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
  memoize(fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');
    const useOptions =
      options &&
      (Object.prototype.hasOwnProperty.call(options, 'ttl') ||
        Object.prototype.hasOwnProperty.call(options, 'weight'))
        ? options
        : this._defaultMemoizeOptions;
    const memoizedFn = /** @type {import('../jsdoc-types.js').MemoizedFunction<F>} */ (
      this._memoize(fn, useOptions)
    );
    // Ordinary functions, not arrows, so the receiver survives. See
    // `_scopedKey` for what that receiver means and why the plain call
    // `memo.get(10)` still resolves the unscoped key.
    const self = this;
    memoizedFn.get = function (...args) {
      return self._getFor(memoizedFn, this, args);
    };
    memoizedFn.has = function (...args) {
      return self._hasFor(memoizedFn, this, args);
    };
    memoizedFn.delete = function (...args) {
      return self._deleteFor(memoizedFn, this, args);
    };
    memoizedFn.clear = () => this.clear();
    memoizedFn.stats = () => this.stats();
    memoizedFn.cache = this.cache;
    memoizedFn.original = fn;
    // NB: do not call `Object.setPrototypeOf(memoizedFn, PowerMemoizer.prototype)`.
    // `PowerMemoizer.prototype` chains to `Object.prototype`, so the mutation
    // removes `Function.prototype` from the chain and the returned function
    // loses `.call`/`.apply`/`.bind`. Use the own-properties above instead.
    /** @type {import('../jsdoc-types.js').MemoizedFunction<F>} */
    return memoizedFn;
  }

  /**
   * Retrieve a cached value for the given call args (if present).
   * @param  {...*} args
   * @returns {*|undefined}
   */
  get(...args) {
    return this._lookup(this.keyResolver(...args));
  }

  /**
   * Check presence for the given call args.
   * @param  {...*} args
   * @returns {boolean}
   */
  has(...args) {
    return this.cache.has(this.keyResolver(...args));
  }

  /**
   * Delete the cached entry for the given call args.
   * Also clears any inflight Promise for the key.
   * @param  {...*} args
   * @returns {boolean}
   */
  delete(...args) {
    return this._evict(this.keyResolver(...args));
  }

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
  _scopedKey(memoizedFn, receiver, args) {
    if (receiver === memoizedFn || receiver == null) return this.keyResolver(...args);
    return this._receiverKey(receiver, args);
  }

  /**
   * @param {string} key
   * @returns {*|undefined}
   * @private
   */
  _lookup(key) {
    return this.cache.get(key);
  }

  /**
   * @param {string} key
   * @returns {boolean}
   * @private
   */
  _evict(key) {
    if (this._inflight.has(key)) this._inflight.delete(key);
    return this.cache.delete(key);
  }

  /**
   * @param {Function} memoizedFn
   * @param {any} receiver
   * @param {any[]} args
   * @returns {*|undefined}
   * @private
   */
  _getFor(memoizedFn, receiver, args) {
    return this._lookup(this._scopedKey(memoizedFn, receiver, args));
  }

  /**
   * @param {Function} memoizedFn
   * @param {any} receiver
   * @param {any[]} args
   * @returns {boolean}
   * @private
   */
  _hasFor(memoizedFn, receiver, args) {
    return this.cache.has(this._scopedKey(memoizedFn, receiver, args));
  }

  /**
   * @param {Function} memoizedFn
   * @param {any} receiver
   * @param {any[]} args
   * @returns {boolean}
   * @private
   */
  _deleteFor(memoizedFn, receiver, args) {
    return this._evict(this._scopedKey(memoizedFn, receiver, args));
  }

  /**
   * Clear all cached entries and any inflight markers.
   * @returns {void}
   */
  clear() {
    this._inflight.clear();
    this.cache.clear();
  }

  /**
   * Expose underlying cache stats.
   * @returns {Object}
   */
  stats() {
    return this.cache.stats();
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
  /**
   * Release the underlying cache.
   *
   * `PowerMemoizer` owns no state of its own - it delegates to a `PowerCache`
   * - so disposal forwards to it. The inner cache is not replaced, so a
   * disposed memoizer's `cache` reference stays readable.
   *
   * @returns {void}
   */
  [Symbol.dispose]() {
    if (typeof this.cache?.[Symbol.dispose] === 'function') {
      this.cache[Symbol.dispose]();
    }
  }

  /**
   * Named alias for the `Symbol.dispose` implementation, so callers who do not
   * want to reach for the symbol still have something to call.
   * @returns {void}
   */
  dispose() {
    this[Symbol.dispose]();
  }
}

/**
 * Structural, type-tagged encoding of one memoizer argument.
 *
 * `simpleArgsKey` used to hand the **whole argument list** to `JSON.stringify`
 * the moment it met anything non-scalar, and that single decision caused four
 * distinct defects, all measured:
 *
 * - `({a:1}, undefined)`, `({a:1}, fn)` and `({a:1}, null)` all produced
 *   `'[{"a":1},null]'` — `JSON.stringify` maps `undefined` and functions to
 *   `null`. A memoizer served the *first* call's value to the other two. That is
 *   the row's report, confirmed with a live `PowerMemoizer`: two distinct calls,
 *   one underlying invocation.
 * - **Every `Map`, `Set`, `RegExp` and `Error` serialised to `'[{}]'`**, so two
 *   unrelated `Map`s were indistinguishable. Worse than the reported case,
 *   because nothing about the inputs suggests they are unencodable.
 * - A `BigInt` *inside* an object threw, while a top-level `BigInt` was
 *   explicitly supported on the fast path — the same value, two answers.
 * - A circular structure threw `Converting circular structure to JSON`.
 *
 * Encoding per argument, with a type tag on each, removes all four: an
 * unencodable value can no longer alias a *different* value, because the
 * alternatives are a distinct tag or a throw.
 *
 * @param {*} v
 * @param {Set<object>} seen - Objects already on the current path, for cycles.
 * @returns {string}
 */
function encodeArg(v, seen) {
  const t = typeof v;
  if (v === null) return 'n:';
  if (t === 'string') return 's:' + v.length + ':' + v;
  // No `-0` normalisation, because it is not needed: `String(-0)` is already
  // `'0'`, so the original `String(v === 0 ? 0 : v)` could not change the result.
  // A test asserted the two were equal and passed whichever way it was written —
  // a guard that cannot fail. Removed when a mutation check proved it.
  if (t === 'number') return 'd:' + String(v);
  if (t === 'boolean') return 'b:' + (v ? '1' : '0');
  if (t === 'undefined') return 'u:';
  if (t === 'bigint') return 'g:' + v.toString();
  if (t === 'symbol') {
    // `JSON.stringify` maps every Symbol to `null`, so falling through would
    // alias *all* Symbol arguments onto one key. Symbols are not serialisable
    // by design, and a `Symbol.keyFor` registry would only be stable within a
    // registry.
    throw new TypeError('simpleArgsKey() does not support symbol arguments');
  }
  if (t === 'function') {
    // A closure has no stable identity: two structurally identical arrows are
    // different functions, and `String(fn)` is the same text for both, so any
    // encoding would either collide or be useless. Refusing is the only answer
    // that cannot be wrong.
    throw new TypeError(
      'simpleArgsKey() does not support function arguments - two closures cannot be told apart. ' +
        'Pass a key explicitly, or supply a `keyResolver`.'
    );
  }

  // A value already on this path is a cycle. Its *depth* is enough to
  // distinguish the structures, and it terminates.
  if (seen.has(v)) return 'c:';
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      let out = 'A:[';
      for (let i = 0; i < v.length; i++) {
        if (i) out += ',';
        out += encodeArg(v[i], seen);
      }
      return out + ']';
    }
    if (v instanceof Date) return 'D:' + v.getTime();
    if (v instanceof RegExp) return 'R:' + v.source + '/' + v.flags;
    if (isError(v)) return 'E:' + v.name + ':' + v.message;
    if (v instanceof Map) {
      // Order is significant for a Map, so it is preserved rather than sorted.
      let out = 'Mp:[';
      let first = true;
      for (const [k, val] of v) {
        if (!first) out += ',';
        first = false;
        out += encodeArg(k, seen) + '=' + encodeArg(val, seen);
      }
      return out + ']';
    }
    if (v instanceof Set) {
      let out = 'St:[';
      let first = true;
      for (const val of v) {
        if (!first) out += ',';
        first = false;
        out += encodeArg(val, seen);
      }
      return out + ']';
    }
    // Plain object. Key order follows insertion order, as `JSON.stringify` did,
    // so an object built the same way twice still matches.
    let out = 'O:{';
    let first = true;
    for (const k of Object.keys(v)) {
      if (!first) out += ',';
      first = false;
      out += 's:' + k.length + ':' + k + '=' + encodeArg(v[k], seen);
    }
    return out + '}';
  } finally {
    // Pop, so a value reached twice on sibling paths is not mistaken for a
    // cycle. `seen` is a path, not a visited-set.
    seen.delete(v);
  }
}

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
export function simpleArgsKey(...args) {
  if (args.length === 0) return '';
  // One encoder for every argument, including the scalars. The previous shape
  // had a fast path for scalars and a wholesale `JSON.stringify` fallback for
  // anything else, and the fallback is where every defect in this row lived:
  // it mapped `undefined`, functions and every `Map`/`Set`/`RegExp` onto the
  // same text, so distinct calls shared a cache entry.
  //
  // The scalar codes are unchanged, so the key format for scalar-only calls —
  // the overwhelmingly common case, and the one the memoizer-key PERF-005 above
  // measured — is
  // byte-identical to before. Only calls that previously hit the fallback
  // change, which is precisely the set that was broken.
  const seen = new Set();
  let out = '';
  for (let i = 0; i < args.length; i++) {
    if (i) out += '|';
    out += encodeArg(args[i], seen);
  }
  return out;
}
