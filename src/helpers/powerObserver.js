/**
 * Lightweight reactive value store.
 * Subscribers are called synchronously when the value changes.
 *
 * Example:
 * const obs = new PowerObserver(42);
 * obs.subscribe((next, prev) => console.log(next, prev));
 * obs.value = 99;
 */
/**
 * @typedef {Object} PowerObserverOptions
 * @property {function} [map]
 * @property {boolean} [distinct]
 * @property {boolean|'microtask'|'macrotask'} [async]
 */
export class PowerObserver {
  /**
   * Create a new PowerObserver.
   * @param {*} initial Initial value
   * @param {PowerObserverOptions} options
   */
  constructor(initial, options = {}) {
    this._value = initial;
    /** @type {Set<Function>} */
    this._subs = new Set();
    this._map = typeof options.map === 'function' ? options.map : null;
    this._distinct = !!options.distinct;

    // scheduling: true (microtask) by default, false => sync, or string mode
    if (options.async === undefined) this._scheduleMode = 'microtask';
    else if (options.async === true) this._scheduleMode = 'microtask';
    else if (options.async === false) this._scheduleMode = 'sync';
    else if (options.async === 'microtask' || options.async === 'macrotask')
      this._scheduleMode = options.async;
    else this._scheduleMode = 'microtask';

    // batching state for scheduled notifications
    this._pending = false;
    this._pendingPrev = undefined;
    this._pendingNext = undefined;
    this._pendingTimer = null; // for macrotask
  }

  /** Current value */
  get value() {
    return this._value;
  }

  /** Set value and schedule notification according to `async` option */
  set value(v) {
    const prev = this._value;
    this._value = v;

    const mapFn = this._map;
    const mappedPrev = mapFn ? mapFn(prev) : prev;
    const mappedNext = mapFn ? mapFn(v) : v;

    if (this._distinct && Object.is(mappedPrev, mappedNext)) return;

    if (this._scheduleMode === 'sync') {
      // deliver immediately
      const subs = Array.from(this._subs);
      for (const s of subs) {
        try {
          s(mappedNext, mappedPrev);
        } catch (e) {
          // swallow subscriber errors
        }
      }
      return;
    }

    // schedule delivery (microtask or macrotask)
    if (!this._pending) {
      this._pending = true;
      this._pendingPrev = mappedPrev;
      this._pendingNext = mappedNext;
      if (this._scheduleMode === 'microtask') {
        queueMicrotask(() => this._flushPending());
      } else {
        // macrotask via setTimeout
        this._pendingTimer = setTimeout(() => this._flushPending(), 0);
      }
    } else {
      // already scheduled: update next value, keep original prev
      this._pendingNext = mappedNext;
    }

    return;
  }

  /**
   * Subscribe to changes. Returns an unsubscribe function.
   * @param {(next:any, prev:any)=>void} fn
   */
  subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('subscriber must be a function');
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  /** Remove all subscribers */
  clear() {
    this._subs.clear();
  }

  /** Number of subscribers */
  get size() {
    return this._subs.size;
  }

  /** Set or replace the mapping function used for notifications */
  map(fn) {
    if (fn == null) this._map = null;
    else if (typeof fn !== 'function') throw new TypeError('map must be a function');
    else this._map = fn;
  }

  /**
   * Flush any pending notification immediately. Useful for tests or shutdown.
   */
  flush() {
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
    if (this._pending) this._flushPending();
  }

  /** Alias for flush() */
  drain() {
    this.flush();
  }

  /** Internal flush implementation */
  _flushPending() {
    if (!this._pending) return;
    this._pending = false;
    const prev = this._pendingPrev;
    const next = this._pendingNext;
    this._pendingPrev = undefined;
    this._pendingNext = undefined;
    const subs = Array.from(this._subs);
    for (const s of subs) {
      try {
        s(next, prev);
      } catch (e) {
        // swallow
      }
    }
  }
}

export default PowerObserver;
