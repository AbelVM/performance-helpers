/**
 * Lightweight Map-like store where each key has an optional TTL (milliseconds).
 * Entries expire lazily on access or iteration. Suitable when LRU/weighting
 * is unnecessary and a simple time-to-live map is desired.
 */
import { nowMs } from '../utils/now.js';

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
  constructor(defaultTTL = 0, options = {}) {
    // Allow `new PowerTTLMap({ defaultTTL, onExpire })` (options-object convention).
    // Reassigning the parameter lost the declared options type at the two reads
    // below, so the normalised value gets its own binding instead.
    /** @type {PowerTTLMapOptions} */
    let opts = options;
    let ttl = defaultTTL;
    if (defaultTTL != null && typeof defaultTTL === 'object') {
      opts = defaultTTL;
      ttl = 0;
    }
    this._defaultTTL = Number(opts?.defaultTTL ?? ttl) || 0; // ms; 0 = no expiry
    this._onExpire = typeof opts?.onExpire === 'function' ? opts.onExpire : null;
    /** @type {Map<any, TTLMapEntry>} */
    this._map = new Map();
    // Track keys that have an expiry to allow faster purging of expired
    // entries without scanning the entire map on each `size` access.
    /** @type {Map<any, number>} */
    this._expirations = new Map();
    this._nextExpiryAt = 0;
    this._nextExpiryDirty = false;
  }

  /**
   * Resolve a TTL argument that may be either a positional number or an
   * options object `{ ttl }` (matching the `PowerCache.set` convention).
   * @private
   * @param {number|{ttl?:number}|undefined} ttl
   * @param {number} fallback Default TTL when `ttl` is nullish.
   * @returns {number} Resolved TTL in ms (0 = no expiry).
   */
  _resolveTtl(ttl, fallback) {
    if (ttl != null && typeof ttl === 'object') ttl = ttl.ttl;
    return ttl == null ? fallback : Number(ttl) || 0;
  }

  /**
   * Set a key with optional TTL (ms).
   * @param {any} key
   * @param {any} value
   * @param {number|{ttl?:number}} [ttl] TTL in milliseconds for this key. Accepts either a
   *   positional number or an options object `{ ttl }` for consistency with `PowerCache.set`.
   * @returns {this}
   */
  set(key, value, ttl) {
    const ms = this._resolveTtl(ttl, this._defaultTTL);
    // add a small slack (+1ms) to account for timer scheduling jitter
    const expiresAt = ms > 0 ? nowMs() + ms + 1 : 0;
    const prevExpiry = this._expirations.get(key) || 0;
    this._map.set(key, { value, expiresAt });
    if (expiresAt) this._expirations.set(key, expiresAt);
    else this._expirations.delete(key);
    this._updateNextExpiryOnWrite(prevExpiry, expiresAt);
    return this;
  }

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
  _expireKey(key, entry) {
    if (!entry) return;
    const expiresAt = entry.expiresAt || this._expirations.get(key) || 0;
    try {
      const val = entry.value;
      this._map.delete(key);
      this._expirations.delete(key);
      if (expiresAt && this._nextExpiryAt === expiresAt) this._nextExpiryDirty = true;
      if (typeof this._onExpire === 'function') {
        try {
          this._onExpire(key, val);
        } catch (e) {
          /* swallow user callback errors */
        }
      }
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Whether a key needs removing: absent, or present and past its expiry.
   * @param {any} key
   * @param {TTLMapEntry} [entry]
   * @returns {boolean}
   */
  _checkExpire(key, entry) {
    if (!entry) return true;
    if (entry.expiresAt && nowMs() > entry.expiresAt) {
      this._expireKey(key, entry);
      return true;
    }
    return false;
  }

  /**
   * Get a value, returning `undefined` when missing or expired.
   * @param {any} key
   * @returns {any|undefined}
   */
  get(key) {
    const entry = this._map.get(key);
    // `_checkExpire` already reports a missing entry as expired, but it is not
    // a type guard, so the narrowing is stated here as well.
    if (entry === undefined || this._checkExpire(key, entry)) return undefined;
    return entry.value;
  }

  /**
   * Check whether a key exists and is not expired.
   * @param {any} key
   * @returns {boolean}
   */
  has(key) {
    const entry = this._map.get(key);
    return !this._checkExpire(key, entry);
  }

  /**
   * Delete a key.
   * @param {any} key
   * @returns {boolean}
   */
  delete(key) {
    const expiresAt = this._expirations.get(key) || 0;
    this._expirations.delete(key);
    if (expiresAt && this._nextExpiryAt === expiresAt) this._nextExpiryDirty = true;
    return this._map.delete(key);
  }

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
  reset() {
    this.clear();
  }

  clear() {
    this._map.clear();
    this._expirations.clear();
    this._nextExpiryAt = 0;
    this._nextExpiryDirty = false;
  }

  /**
   * Refresh TTL for an existing key. No-op if missing/expired.
   * @param {any} key
   * @param {number|{ttl?:number}} [ttl]
   * @returns {boolean} True when TTL refreshed.
   */
  touch(key, ttl) {
    const entry = this._map.get(key);
    if (!entry) return false;
    if (entry.expiresAt && nowMs() > entry.expiresAt) {
      this._expireKey(key, entry);
      return false;
    }
    const prevExpiry = entry.expiresAt || 0;
    const ms = this._resolveTtl(ttl, this._defaultTTL);
    // add a small slack (+1ms) to account for timer scheduling jitter
    entry.expiresAt = ms > 0 ? nowMs() + ms + 1 : 0;
    if (entry.expiresAt) this._expirations.set(key, entry.expiresAt);
    else this._expirations.delete(key);
    this._updateNextExpiryOnWrite(prevExpiry, entry.expiresAt);
    return true;
  }

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
  get size() {
    return this._map.size;
  }

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
  get expiredCount() {
    if (!this._map.size || !this._expirations.size) return 0;
    const now = nowMs();
    let expired = 0;
    for (const exp of this._expirations.values()) {
      if (exp && now > exp) expired++;
    }
    return expired;
  }

  /**
   * Collect every entry that is already past its expiry, firing `onExpire` for
   * each.
   *
   * The explicit spelling of what `size` used to do implicitly. Reads and
   * `expiredCount` are pure; collection is opt-in.
   *
   * @returns {number} How many entries were removed.
   */
  purge() {
    if (!this._map.size || !this._expirations.size) return 0;
    // One clock read for both the count and the sweep, so an entry that expires
    // between the two cannot make the returned number disagree with what was
    // actually removed.
    const now = nowMs();
    let removed = 0;
    for (const exp of this._expirations.values()) {
      if (exp && now > exp) removed++;
    }
    if (removed) this._sweepExpirations(now);
    return removed;
  }

  /**
   * Keep `_nextExpiryAt` pointing at the soonest live expiry, invalidating the
   * cached `size` shortcut when the entry that held it is gone or replaced.
   *
   * @param {number} prevExpiry - The key's expiry before this write, `0` if none.
   * @param {number} nextExpiry - The key's expiry after this write, `0` if none.
   * @returns {void}
   */
  _updateNextExpiryOnWrite(prevExpiry, nextExpiry) {
    if (prevExpiry && this._nextExpiryAt === prevExpiry && prevExpiry !== nextExpiry) {
      this._nextExpiryDirty = true;
    }

    if (nextExpiry && (!this._nextExpiryAt || nextExpiry < this._nextExpiryAt)) {
      this._nextExpiryAt = nextExpiry;
    }
  }

  /**
   * Drop every expired entry the expiration index knows about, then recompute
   * the soonest remaining expiry.
   *
   * @param {number} now
   * @returns {void}
   */
  _sweepExpirations(now) {
    let nextExpiryAt = 0;
    for (const [k, exp] of this._expirations) {
      if (exp && now > exp) {
        const entry = this._map.get(k);
        this._expireKey(k, entry);
        continue;
      }
      if (exp && (!nextExpiryAt || exp < nextExpiryAt)) nextExpiryAt = exp;
    }
    this._nextExpiryAt = nextExpiryAt;
    this._nextExpiryDirty = false;
  }

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
  *entries() {
    const now = nowMs();
    for (const [k, entry] of this._map) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this._expireKey(k, entry);
        continue;
      }
      yield [k, entry.value];
    }
  }

  /**
   * Iterate keys of non-expired entries.
   * @returns {IterableIterator<any>}
   */
  *keys() {
    for (const [k] of this.entries()) yield k;
  }

  /**
   * Iterate values of non-expired entries.
   * @returns {IterableIterator<any>}
   */
  *values() {
    for (const [, v] of this.entries()) yield v;
  }

  /**
   * Call `cb` for each non-expired entry.
   * @param {(value:any, key:any, map:PowerTTLMap)=>void} cb
   * @param {any} [thisArg]
   * @returns {void}
   */
  forEach(cb, thisArg) {
    for (const [k, v] of this.entries()) cb.call(thisArg, v, k, this);
  }

  /**
   * Default iterator yielding `[key, value]` pairs for non-expired entries.
   */
  [Symbol.iterator]() {
    return this.entries();
  }

  /**
   * Release every resource this instance holds.
   *
   * Idempotent, and safe to call while the instance is idle. Exists so the
   * instance works with `using` / `await using` and gives callers an explicit
   * name to call.
   *
   * @returns {void}
   */
  dispose() {
    this.clear();
    // Neutralise the cleanup so a second dispose (or a late call) is a no-op
    // rather than a second teardown pass.
    this.clear = () => {};
  }

  /**
   * Alias for {@link dispose}, so `using x = new X()` releases the instance
   * deterministically at scope exit.
   * @returns {void}
   */
  [Symbol.dispose]() {
    this.dispose();
  }
}

export default PowerTTLMap;
