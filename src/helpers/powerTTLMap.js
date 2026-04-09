/**
 * Lightweight Map-like store where each key has an optional TTL (milliseconds).
 * Entries expire lazily on access or iteration. Suitable when LRU/weighting
 * is unnecessary and a simple time-to-live map is desired.
 */
import { nowMs } from '../utils/now.js';

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
   * @param {number} [defaultTTL=0] Default TTL in milliseconds for keys set without explicit ttl (0 = no expiry).
   */
  /**
   * @typedef {import('./jsdoc-types.js').PowerTTLMapOptions} PowerTTLMapOptions
   */
  constructor(defaultTTL = 0, options = {}) {
    this._defaultTTL = Number(defaultTTL) || 0; // milliseconds; 0 = no expiry
    this._onExpire = typeof options?.onExpire === 'function' ? options.onExpire : null;
    this._map = new Map(); // key -> { value, expiresAt }
    // Track keys that have an expiry to allow faster purging of expired
    // entries without scanning the entire map on each `size` access.
    this._expirations = new Map(); // key -> expiresAt (ms)
    this._nextExpiryAt = 0;
    this._nextExpiryDirty = false;
  }

  /**
   * Set a key with optional TTL (ms).
   * @param {any} key
   * @param {any} value
   * @param {number} [ttl] TTL in milliseconds for this key.
   * @returns {this}
   */
  set(key, value, ttl) {
    const ms = ttl == null ? this._defaultTTL : Number(ttl) || 0;
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
    if (this._checkExpire(key, entry)) return undefined;
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
  clear() {
    this._map.clear();
    this._expirations.clear();
    this._nextExpiryAt = 0;
    this._nextExpiryDirty = false;
  }

  /**
   * Refresh TTL for an existing key. No-op if missing/expired.
   * @param {any} key
   * @param {number} [ttl]
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
    const ms = ttl == null ? this._defaultTTL : Number(ttl) || 0;
    // add a small slack (+1ms) to account for timer scheduling jitter
    entry.expiresAt = ms > 0 ? nowMs() + ms + 1 : 0;
    if (entry.expiresAt) this._expirations.set(key, entry.expiresAt);
    else this._expirations.delete(key);
    this._updateNextExpiryOnWrite(prevExpiry, entry.expiresAt);
    return true;
  }

  /**
   * Number of non-expired entries (purges expired entries lazily).
   * @returns {number}
   */
  get size() {
    // Purge expired entries lazily, but iterate only the subset of keys
    // that have expirations recorded. This avoids scanning non-expiring
    // entries on every `.size` access. When the next known expiry is still
    // in the future, return immediately without sweeping the expiration index.
    if (!this._map.size) return 0;
    if (!this._expirations.size) return this._map.size;
    const now = nowMs();
    if (!this._nextExpiryDirty && this._nextExpiryAt && now <= this._nextExpiryAt) {
      return this._map.size;
    }

    this._sweepExpirations(now);
    return this._map.size;
  }

  _updateNextExpiryOnWrite(prevExpiry, nextExpiry) {
    if (prevExpiry && this._nextExpiryAt === prevExpiry && prevExpiry !== nextExpiry) {
      this._nextExpiryDirty = true;
    }

    if (nextExpiry && (!this._nextExpiryAt || nextExpiry < this._nextExpiryAt)) {
      this._nextExpiryAt = nextExpiry;
    }
  }

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
   * @param {Function} cb
   * @param {any} [thisArg]
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
}

export default PowerTTLMap;
