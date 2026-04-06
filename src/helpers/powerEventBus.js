/**
 * Typed micro event bus.
 * Lightweight pub/sub for intra-process coordination.
 * Subscriber errors are swallowed to avoid breaking emitters.
 */
const _ORIGINAL = Symbol('PowerEventBus.originalListener');
// Optional symbol used to attach once-wrappers directly on user listener
// functions when the environment allows assigning properties to functions.
const _ONCE_WRAPPERS = Symbol('PowerEventBus.onceWrappers');
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
    // per-event live listener counts to avoid allocating arrays when checking limits
    this._liveCounts = new Map();
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
          this._removeListenerEntry(event, s, ref);
        } catch (e) {
          /* ignore finalizer errors */
        }
      });
    } else {
      this._fr = null;
      // WeakMap from original listener -> Map(event -> wrapped)
      // Allows `off(event, originalFn)` to remove the wrapped once-listener.
      this._onceMap = new WeakMap();
    }
  }

  /**
   * Cleanup dead weak refs from internal listener sets.
   * Useful in tests or environments where FinalizationRegistry/GC is unavailable.
   */
  cleanup() {
    if (!this._weak) return;
    for (const [event, set] of this._listeners) {
      for (const entry of set) {
        if (entry && typeof entry.deref === 'function') {
          const v = entry.deref();
          if (!v) this._removeListenerEntry(event, set, entry);
        }
      }
      if (set.size === 0) this._listeners.delete(event);
    }
  }

  _decrementLiveCount(event) {
    const prev = this._liveCounts.get(event) || 0;
    const next = Math.max(0, prev - 1);
    if (next === 0) this._liveCounts.delete(event);
    else this._liveCounts.set(event, next);
  }

  _removeListenerEntry(event, set, entry) {
    const removed = set.delete(entry);
    if (!removed) return false;
    this._decrementLiveCount(event);
    if (set.size === 0) {
      this._listeners.delete(event);
      this._liveCounts.delete(event);
    }
    return true;
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
      this._liveCounts.set(event, 0);
    }

    // Clean dead weak refs before counting
    if (this._weak) {
      // remove dead refs and reconcile count lazily
      for (const entry of s) {
        const fn2 = entry && typeof entry.deref === 'function' ? entry.deref() : entry;
        if (!fn2) this._removeListenerEntry(event, s, entry);
      }
    }

    const liveCount = this._liveCounts.get(event) || (this._weak ? 0 : s.size);

    if (this._maxListeners > 0 && liveCount + 1 > this._maxListeners) {
      throw new Error(
        `PowerEventBus: adding listener for "${event}" exceeds maxListeners (${this._maxListeners})`
      );
    }

    if (this._weak && typeof WeakRef !== 'undefined') {
      const ref = new WeakRef(fn);
      s.add(ref);
      if (this._fr) this._fr.register(fn, { event, ref }, ref);
      // increment live count
      this._liveCounts.set(event, (this._liveCounts.get(event) || 0) + 1);
      return () => {
        const removed = s.delete(ref);
        if (removed) {
          const prev = this._liveCounts.get(event) || 0;
          const next = Math.max(0, prev - 1);
          if (next === 0) this._liveCounts.delete(event);
          else this._liveCounts.set(event, next);
        }
        if (this._fr) this._fr.unregister(ref);
      };
    }

    s.add(fn);
    // increment live count for non-weak listeners
    this._liveCounts.set(event, (this._liveCounts.get(event) || 0) + 1);
    return () => {
      const removed = s.delete(fn);
      if (removed) {
        const prev = this._liveCounts.get(event) || 0;
        const next = Math.max(0, prev - 1);
        if (next === 0) this._liveCounts.delete(event);
        else this._liveCounts.set(event, next);
      }
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
    // Mark wrapper with original for cleanup and bookkeeping
    try {
      wrapped[_ORIGINAL] = fn;
      // Prefer attaching a Map directly on the original function via a Symbol
      // to avoid allocating a WeakMap per bus. Fall back to the WeakMap when
      // attaching properties is impossible (frozen/non-extensible functions).
      let mset;
      try {
        mset = fn[_ONCE_WRAPPERS];
        if (!mset) {
          mset = new Map();
          Object.defineProperty(fn, _ONCE_WRAPPERS, { value: mset, configurable: true });
        }
        mset.set(event, wrapped);
      } catch (attachErr) {
        // fallback to WeakMap bookkeeping
        let m = this._onceMap.get(fn);
        if (!m) {
          m = new Map();
          this._onceMap.set(fn, m);
        }
        m.set(event, wrapped);
      }
    } catch (err) {
      // best-effort; if environment disallows setting properties, continue
    }
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
    // If caller passed the original function used with `once()`, remove the wrapped listener too
    if (typeof fn === 'function') {
      // First try symbol-attached Map on the function (fast-path)
      try {
        const mset = fn[_ONCE_WRAPPERS];
        if (mset && mset instanceof Map) {
          const wrapped = mset.get(event);
          if (wrapped) {
            if (this._weak) {
              for (const entry of s) {
                const val = entry && typeof entry.deref === 'function' ? entry.deref() : entry;
                if (val === wrapped) this._removeListenerEntry(event, s, entry);
              }
            } else {
              this._removeListenerEntry(event, s, wrapped);
            }
            mset.delete(event);
            if (mset.size === 0) {
              try {
                delete fn[_ONCE_WRAPPERS];
              } catch (e) {
                /* ignore */
              }
            }
          }
        } else {
          // Fallback to WeakMap bookkeeping used previously
          const m = this._onceMap.get(fn);
          if (m) {
            const wrapped = m.get(event);
            if (wrapped) {
              if (this._weak) {
                for (const entry of s) {
                  const val = entry && typeof entry.deref === 'function' ? entry.deref() : entry;
                  if (val === wrapped) this._removeListenerEntry(event, s, entry);
                }
              } else {
                this._removeListenerEntry(event, s, wrapped);
              }
              m.delete(event);
              if (m.size === 0) this._onceMap.delete(fn);
            }
          }
        }
      } catch (err) {
        // on any failure, fall back to original WeakMap path
        const m = this._onceMap.get(fn);
        if (m) {
          const wrapped = m.get(event);
          if (wrapped) {
            if (this._weak) {
              for (const entry of s) {
                const val = entry && typeof entry.deref === 'function' ? entry.deref() : entry;
                if (val === wrapped) this._removeListenerEntry(event, s, entry);
              }
            } else {
              this._removeListenerEntry(event, s, wrapped);
            }
            m.delete(event);
            if (m.size === 0) this._onceMap.delete(fn);
          }
        }
      }
    }
    if (this._weak) {
      for (const entry of s) {
        const val = entry && typeof entry.deref === 'function' ? entry.deref() : entry;
        if (val === fn) this._removeListenerEntry(event, s, entry);
      }
    } else {
      this._removeListenerEntry(event, s, fn);
    }
    // If `fn` was a wrapped function, remove its original->wrapped bookkeeping
    try {
      const orig = fn && fn[_ORIGINAL];
      if (orig) {
        const mm = this._onceMap.get(orig);
        if (mm) {
          mm.delete(event);
          if (mm.size === 0) this._onceMap.delete(orig);
        }
      }
    } catch (err) {
      // ignore
    }
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
    for (const entry of s) {
      let fn = entry;
      if (this._weak && entry && typeof entry.deref === 'function') fn = entry.deref();
      if (!fn) {
        // dead weak ref; cleanup
        this._removeListenerEntry(event, s, entry);
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
   * Emit an event to all subscribers and await async listeners.
   * Supports bounded concurrency so long listener lists can be processed in
   * batches without flooding the event loop.
   * Errors thrown or rejected by listeners are swallowed.
   * @param {string} event
   * @param {any} [payload]
   * @param {Object} [options]
   * @param {number} [options.concurrency=Infinity]
   * @returns {Promise<boolean>}
   */
  async emitAsync(event, payload, { concurrency = Infinity } = {}) {
    const listeners = this.listeners(event);
    if (listeners.length === 0) return false;

    const normalizeConcurrency =
      Number.isFinite(+concurrency) && +concurrency > 0
        ? Math.max(1, Math.floor(+concurrency))
        : Infinity;

    const invoke = async (fn) => {
      try {
        await fn(payload);
      } catch (e) {
        // swallow subscriber errors
      }
    };

    if (!Number.isFinite(normalizeConcurrency) || normalizeConcurrency >= listeners.length) {
      await Promise.all(listeners.map(invoke));
      return true;
    }

    let nextIndex = 0;
    const workers = Array.from({ length: normalizeConcurrency }, async () => {
      while (nextIndex < listeners.length) {
        const fn = listeners[nextIndex++];
        if (!fn) continue;
        await invoke(fn);
      }
    });

    await Promise.all(workers);
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
    for (const entry of s) {
      const fn = entry && typeof entry.deref === 'function' ? entry.deref() : entry;
      if (fn) out.push(fn);
      else this._removeListenerEntry(event, s, entry);
    }
    return out;
  }

  /**
   * Clear listeners for an event or all events when called without args.
   * @param {string} [event]
   */
  clear(event) {
    if (event === undefined) {
      this._listeners.clear();
      this._liveCounts.clear();
      return;
    }
    this._listeners.delete(event);
    this._liveCounts.delete(event);
  }
}

export default PowerEventBus;
