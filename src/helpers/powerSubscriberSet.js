/**
 * Shared subscriber set helper used by event buses and observable stores.
 *
 * Supports optional weak references, once-listeners, and max listener counts.
 */
const ORIGINAL = Symbol('PowerSubscriberSet.original');

/**
 * PowerSubscriberSet
 *
 * Shared subscriber set helper used by event buses and observable stores.
 * Supports optional weak references, once-listeners, and max listener counts.
 *
 * @class PowerSubscriberSet
 * @public
 */
export class PowerSubscriberSet {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.weak=false]
   * @param {number} [options.maxListeners=0]
   */
  constructor(options = {}) {
    const { weak = false, maxListeners = 0 } = options || {};
    this._weak = Boolean(weak);
    this._maxListeners = Number.isFinite(Number(maxListeners))
      ? Math.max(0, Math.floor(Number(maxListeners)))
      : 0;
    this._listeners = new Set();
    this._onceMap = new WeakMap();
    this._finalization = null;
    if (
      this._weak &&
      typeof WeakRef !== 'undefined' &&
      typeof FinalizationRegistry !== 'undefined'
    ) {
      this._finalization = new FinalizationRegistry((token) => {
        this._listeners.delete(token.ref);
      });
    }
  }

  /** Number of currently live listeners. */
  get size() {
    this._cleanup();
    return this._listeners.size;
  }

  /**
   * Add a listener and return an unsubscribe function.
   * @param {Function|WeakRef} fn Listener function or WeakRef when `weak` mode is enabled.
   * @returns {() => boolean} Unsubscribe function that removes the listener.
   */
  add(fn) {
    if (typeof fn !== 'function') {
      if (!this._weak || !fn || typeof fn.deref !== 'function') {
        throw new TypeError('listener must be a function');
      }
      if (this._maxListeners > 0 && this.size + 1 > this._maxListeners) {
        throw new Error(
          `PowerSubscriberSet: adding listener exceeds maxListeners (${this._maxListeners})`
        );
      }
      this._listeners.add(fn);
      return () => this.delete(fn);
    }

    if (this._maxListeners > 0 && this.size + 1 > this._maxListeners) {
      throw new Error(
        `PowerSubscriberSet: adding listener exceeds maxListeners (${this._maxListeners})`
      );
    }
    const entry = this._makeEntry(fn);
    this._listeners.add(entry);
    return () => this.delete(fn);
  }

  /**
   * Add a once listener and return an unsubscribe function.
   * The original listener will be removed after the first invocation.
   * @param {Function} fn Listener function.
   * @returns {() => boolean} Unsubscribe function.
   */
  addOnce(fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    const wrapped = (...args) => {
      try {
        fn(...args);
      } finally {
        this.delete(fn);
      }
    };
    try {
      wrapped[ORIGINAL] = fn;
    } catch (e) {
      // ignore environments that disallow setting properties on functions
    }
    this._onceMap.set(fn, wrapped);
    if (this._maxListeners > 0 && this.size + 1 > this._maxListeners) {
      throw new Error(
        `PowerSubscriberSet: adding listener exceeds maxListeners (${this._maxListeners})`
      );
    }
    const entry = this._makeEntry(wrapped);
    this._listeners.add(entry);
    return () => this.delete(fn);
  }

  /**
   * Delete a listener by original function or once-wrapper.
   * @param {Function|WeakRef} fn Original listener function or its WeakRef wrapper.
   * @returns {boolean} `true` if a listener was removed, otherwise `false`.
   */
  delete(fn) {
    let target = fn;
    const wrapped = this._onceMap.get(fn);
    if (wrapped) {
      target = wrapped;
      this._onceMap.delete(fn);
    }

    for (const entry of this._listeners) {
      if (entry === target) {
        this._listeners.delete(entry);
        if (this._finalization && typeof entry.deref === 'function') {
          this._finalization.unregister(entry);
        }
        return true;
      }
      const listener = this._deref(entry);
      if (!listener) {
        this._listeners.delete(entry);
        continue;
      }
      if (listener === target) {
        this._listeners.delete(entry);
        if (this._finalization && typeof entry.deref === 'function') {
          this._finalization.unregister(entry);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Iterate live listeners in insertion order and invoke a callback.
   * @param {(listener: Function) => void} fn Callback invoked for each live listener.
   * @returns {void}
   */
  forEach(fn) {
    for (const entry of this._listeners) {
      const listener = this._deref(entry);
      if (!listener) {
        this._listeners.delete(entry);
        continue;
      }
      fn(listener);
    }
  }

  /**
   * Clear all listeners.
   * @returns {void}
   */
  clear() {
    this._listeners.clear();
    this._onceMap = new WeakMap();
  }

  /**
   * Return a safe array copy of live listeners.
   * @returns {Function[]} Array of live listener functions.
   */
  values() {
    this._cleanup();
    const result = [];
    for (const entry of this._listeners) {
      const fn = this._deref(entry);
      if (fn) result.push(fn);
    }
    return result;
  }

  /**
   * Iterate live listeners in insertion order.
   * @yields {Function}
   */
  *[Symbol.iterator]() {
    for (const entry of this._listeners) {
      const fn = this._deref(entry);
      if (!fn) {
        this._listeners.delete(entry);
        continue;
      }
      yield fn;
    }
  }

  /** Remove dead weak refs from the set. */
  _cleanup() {
    if (!this._weak || typeof WeakRef === 'undefined') return;
    for (const entry of this._listeners) {
      if (typeof entry?.deref === 'function' && !entry.deref()) {
        this._listeners.delete(entry);
      }
    }
  }

  _makeEntry(fn) {
    if (this._weak && typeof WeakRef !== 'undefined') {
      const ref = new WeakRef(fn);
      if (this._finalization) {
        try {
          this._finalization.register(fn, { ref }, ref);
        } catch (e) {
          // ignore registration failures
        }
      }
      return ref;
    }
    return fn;
  }

  _deref(entry) {
    return typeof entry?.deref === 'function' ? entry.deref() : entry;
  }
}

/**
 * Cleanup dead weak refs from a subscriber bucket.
 *
 * @public
 * @param {any} bucket
 */
export function cleanupWeakRefs(bucket) {
  if (!bucket) return;
  if (typeof bucket.cleanup === 'function') {
    try {
      bucket.cleanup();
    } catch (e) {
      // ignore cleanup failures
    }
    return;
  }
  if (typeof bucket._cleanup === 'function') {
    try {
      bucket._cleanup();
    } catch (e) {
      // ignore cleanup failures
    }
    return;
  }
  if (typeof bucket[Symbol.iterator] === 'function' && typeof bucket.delete === 'function') {
    for (const entry of bucket) {
      const fn = typeof entry?.deref === 'function' ? entry.deref() : entry;
      if (!fn) bucket.delete(entry);
    }
  }
}
