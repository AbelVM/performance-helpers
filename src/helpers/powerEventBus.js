/**
 * Typed micro event bus.
 * Lightweight pub/sub for intra-process coordination.
 * Subscriber errors are swallowed to avoid breaking emitters.
 */
/**
 * @typedef {Object} PowerEventBusOptions
 * @property {number} [maxListeners]
 * @property {boolean} [weak]
 */
export class PowerEventBus {
  /**
   * @param {{maxListeners?: number, weak?: boolean}=} options
   */
  constructor(options = {}) {
    /** @type {Map<string, Set<any>>} */
    this._listeners = new Map();
    this._maxListeners = Number.isFinite(Number(options.maxListeners))
      ? Math.max(0, Number(options.maxListeners))
      : 0; // 0 means unlimited
    this._weak = Boolean(options.weak);
    if (this._weak && typeof FinalizationRegistry !== 'undefined') {
      this._fr = new FinalizationRegistry((token) => {
        try {
          const { event, ref } = token;
          const s = this._listeners.get(event);
          if (!s) return;
          s.delete(ref);
          if (s.size === 0) this._listeners.delete(event);
        } catch (e) {
          /* ignore finalizer errors */
        }
      });
    } else {
      this._fr = null;
    }
  }

  /**
   * Cleanup dead weak refs from internal listener sets.
   * Useful in tests or environments where FinalizationRegistry/GC is unavailable.
   */
  cleanup() {
    if (!this._weak) return;
    for (const [event, set] of Array.from(this._listeners.entries())) {
      for (const entry of Array.from(set)) {
        if (entry && typeof entry.deref === 'function') {
          const v = entry.deref();
          if (!v) set.delete(entry);
        }
      }
      if (set.size === 0) this._listeners.delete(event);
    }
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {(payload:any)=>void} fn
   * @returns {() => void} unsubscribe
   */
  on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    let s = this._listeners.get(event);
    if (!s) {
      s = new Set();
      this._listeners.set(event, s);
    }

    // Clean dead weak refs before counting
    if (this._weak) {
      for (const entry of Array.from(s)) {
        const fn2 = entry && typeof entry.deref === 'function' ? entry.deref() : entry;
        if (!fn2) s.delete(entry);
      }
    }

    const liveCount = Array.from(s).reduce((acc, entry) => {
      if (this._weak)
        return acc + (entry && typeof entry.deref === 'function' && entry.deref() ? 1 : 0);
      return acc + 1;
    }, 0);

    if (this._maxListeners > 0 && liveCount + 1 > this._maxListeners) {
      throw new Error(
        `PowerEventBus: adding listener for "${event}" exceeds maxListeners (${this._maxListeners})`
      );
    }

    if (this._weak && typeof WeakRef !== 'undefined') {
      const ref = new WeakRef(fn);
      s.add(ref);
      if (this._fr) this._fr.register(fn, { event, ref }, ref);
      return () => {
        s.delete(ref);
        if (this._fr) this._fr.unregister(ref);
      };
    }

    s.add(fn);
    return () => {
      s.delete(fn);
    };
  }

  /**
   * Subscribe once to an event. Listener is removed after first invocation.
   * @param {string} event
   * @param {(payload:any)=>void} fn
   * @returns {() => void} unsubscribe
   */
  once(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    const wrapped = (payload) => {
      try {
        fn(payload);
      } finally {
        this.off(event, wrapped);
      }
    };
    return this.on(event, wrapped);
  }

  /**
   * Remove a specific listener for an event.
   * @param {string} event
   * @param {(payload:any)=>void} fn
   */
  off(event, fn) {
    const s = this._listeners.get(event);
    if (!s) return;
    if (this._weak) {
      for (const entry of Array.from(s)) {
        const val = entry && typeof entry.deref === 'function' ? entry.deref() : entry;
        if (val === fn) s.delete(entry);
      }
    } else {
      s.delete(fn);
    }
    if (s.size === 0) this._listeners.delete(event);
  }

  /**
   * Emit an event to all subscribers. Returns true if any listeners were notified.
   * Errors thrown by listeners are swallowed.
   * @param {string} event
   * @param {any} [payload]
   * @returns {boolean}
   */
  emit(event, payload) {
    const s = this._listeners.get(event);
    if (!s || s.size === 0) return false;
    // snapshot to allow mutation during iteration
    for (const entry of Array.from(s)) {
      let fn = entry;
      if (this._weak && entry && typeof entry.deref === 'function') fn = entry.deref();
      if (!fn) {
        // dead weak ref; cleanup
        s.delete(entry);
        continue;
      }
      try {
        fn(payload);
      } catch (e) {
        // swallow subscriber errors
      }
    }
    if (s.size === 0) this._listeners.delete(event);
    return true;
  }

  /**
   * Return array of listeners for an event (copy).
   * @param {string} event
   * @returns {Function[]}
   */
  listeners(event) {
    const s = this._listeners.get(event);
    if (!s) return [];
    const out = [];
    for (const entry of Array.from(s)) {
      const fn = entry && typeof entry.deref === 'function' ? entry.deref() : entry;
      if (fn) out.push(fn);
      else s.delete(entry);
    }
    if (s.size === 0) this._listeners.delete(event);
    return out;
  }

  /**
   * Clear listeners for an event or all events when called without args.
   * @param {string} [event]
   */
  clear(event) {
    if (event === undefined) this._listeners.clear();
    else this._listeners.delete(event);
  }
}

export default PowerEventBus;
