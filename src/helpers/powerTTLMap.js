/**
 * Lightweight Map-like store where each key has an optional TTL (milliseconds).
 * Entries expire lazily on access or iteration. Suitable when LRU/weighting
 * is unnecessary and a simple time-to-live map is desired.
 */
export class PowerTTLMap {
  /**
   * @param {number} [defaultTTL=0] Default TTL in milliseconds for keys set without explicit ttl (0 = no expiry).
   */
  constructor(defaultTTL = 0) {
    this._defaultTTL = Number(defaultTTL) || 0; // milliseconds; 0 = no expiry
    this._map = new Map(); // key -> { value, expiresAt }
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
    const expiresAt = ms > 0 ? Date.now() + ms : 0;
    this._map.set(key, { value, expiresAt });
    return this;
  }

  /**
   * Internal: remove entry if expired; returns true if removed or missing.
   * @private
   * @param {any} key
   * @param {{value:any,expiresAt:number}|undefined} entry
   * @returns {boolean}
   */
  _checkExpire(key, entry) {
    if (!entry) return true;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this._map.delete(key);
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
    return this._map.delete(key);
  }

  /**
   * Remove all entries.
   * @returns {void}
   */
  clear() {
    this._map.clear();
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
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this._map.delete(key);
      return false;
    }
    const ms = ttl == null ? this._defaultTTL : Number(ttl) || 0;
    entry.expiresAt = ms > 0 ? Date.now() + ms : 0;
    return true;
  }

  /**
   * Number of non-expired entries (purges expired entries lazily).
   * @returns {number}
   */
  get size() {
    // purge expired lazily
    if (!this._map.size) return 0;
    const now = Date.now();
    for (const [k, entry] of this._map) {
      if (entry.expiresAt && now > entry.expiresAt) this._map.delete(k);
    }
    return this._map.size;
  }

  /**
   * Iterate entries [key, value] skipping expired entries.
   * @returns {IterableIterator<[any, any]>}
   */
  *entries() {
    const now = Date.now();
    for (const [k, entry] of this._map) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this._map.delete(k);
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
