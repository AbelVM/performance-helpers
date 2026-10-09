import { assertKnownOptions, assertLimitRequired } from '../utils/options.js';

/**
 * PowerDeduplication
 *
 * Time-windowed deduplicator. Tracks keys seen within a TTL window and
 * prevents re-emitting/reprocessing the same key within that window.
 *
 * @class PowerDeduplication
 * @public
 */
export class PowerDeduplication {
  /**
   * @typedef {import('./jsdoc-types.js').PowerDeduplicationOptions} PowerDeduplicationOptions
   */
  /**
   * @param {number | PowerDeduplicationOptions} [options]
   */
  constructor(options = {}) {
    /** @type {PowerDeduplicationOptions} */
    let opts = /** @type {any} */ (options);
    if (typeof options === 'number') {
      opts = { ttl: options };
    }
    assertKnownOptions(opts, ['ttl', 'maxKeys', 'now'], 'PowerDeduplication');
    const ttl = assertLimitRequired(opts.ttl, {
      name: 'ttl',
      className: 'PowerDeduplication',
      min: 0,
      fallback: 60000,
    });
    const maxKeys =
      opts.maxKeys !== undefined
        ? assertLimitRequired(opts.maxKeys, {
            name: 'maxKeys',
            className: 'PowerDeduplication',
            min: 0,
            fallback: 1000,
          })
        : 1000;
    this._ttl = ttl;
    this._maxKeys = maxKeys;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    /** @type {Map<any, number>} */
    this._keys = new Map();
    this._disposed = false;
  }

  /**
   * Test if key is duplicate. If not seen (or expired), mark it as seen and return false.
   * If seen within TTL, return true.
   * @param {any} key
   * @returns {boolean}
   */
  has(key) {
    if (this._disposed) return true;
    const now = this._now();
    const ts = this._keys.get(key);
    if (ts !== undefined && now - ts < this._ttl) {
      return true;
    }
    this._prune(now);
    if (this._maxKeys > 0 && this._keys.size >= this._maxKeys) {
      const first = this._keys.keys().next();
      if (!first.done) {
        this._keys.delete(first.value);
      }
    }
    this._keys.set(key, now);
    return false;
  }

  /**
   * Mark key as seen regardless of previous state.
   * @param {any} key
   * @returns {void}
   */
  mark(key) {
    if (this._disposed) return;
    const now = this._now();
    this._prune(now);
    if (this._maxKeys > 0 && this._keys.size >= this._maxKeys) {
      const first = this._keys.keys().next();
      if (!first.done) {
        this._keys.delete(first.value);
      }
    }
    this._keys.set(key, now);
  }

  /**
   * Remove key from dedup set.
   * @param {any} key
   * @returns {boolean}
   */
  delete(key) {
    if (this._disposed) return false;
    return this._keys.delete(key);
  }

  /**
   * Clear all keys.
   * @returns {void}
   */
  clear() {
    this._keys.clear();
  }

  /**
   * Alias for clear.
   * @returns {void}
   */
  reset() {
    this.clear();
  }

  /** @param {number} now */ _prune(now) {
    if (this._ttl <= 0) return;
    for (const [k, ts] of this._keys) {
      if (now - ts >= this._ttl) {
        this._keys.delete(k);
      } else {
        break;
      }
    }
  }

  get size() {
    const now = this._now();
    this._prune(now);
    return this._keys.size;
  }

  get length() {
    return this.size;
  }

  isEmpty() {
    return this.size === 0;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.clear();
  }

  [Symbol.dispose]() {
    this.dispose();
  }

  async [Symbol.asyncDispose]() {
    this.dispose();
    return;
  }
}

export default PowerDeduplication;
