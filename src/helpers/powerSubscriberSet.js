/**
 * Shared subscriber set helper used by event buses and observable stores.
 *
 * Supports optional weak references, once-listeners, and max listener counts.
 */
const ORIGINAL = Symbol('PowerSubscriberSet.original');

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

  /** Add a listener and return an unsubscribe function. */
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

  /** Add a once listener and return an unsubscribe function. */
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

  /** Delete a listener by original function or once-wrapper. */
  delete(fn) {
    let target = fn;
    const wrapped = this._onceMap.get(fn);
    if (wrapped) {
      target = wrapped;
      this._onceMap.delete(fn);
    }

    for (const entry of Array.from(this._listeners)) {
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

  /** Clear all listeners. */
  clear() {
    this._listeners.clear();
    this._onceMap = new WeakMap();
  }

  /** Return a safe array copy of live listeners. */
  values() {
    this._cleanup();
    const result = [];
    for (const entry of this._listeners) {
      const fn = this._deref(entry);
      if (fn) result.push(fn);
    }
    return result;
  }

  /** Iterate live listeners in insertion order. */
  [Symbol.iterator]() {
    return this.values()[Symbol.iterator]();
  }

  /** Remove dead weak refs from the set. */
  _cleanup() {
    if (!this._weak || typeof WeakRef === 'undefined') return;
    for (const entry of Array.from(this._listeners)) {
      if (entry && typeof entry.deref === 'function' && !entry.deref()) {
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
    return entry && typeof entry.deref === 'function' ? entry.deref() : entry;
  }
}
