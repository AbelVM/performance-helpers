import { PowerSubscriberSet, cleanupWeakRefs } from './powerSubscriberSet.js';

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
    this._listeners = new Map();
    this._maxListeners = Number.isFinite(Number(options.maxListeners))
      ? Math.max(0, Number(options.maxListeners))
      : 0; // 0 means unlimited
    this._weak = Boolean(options.weak);
    this._fr = null;
    this._finalizationRefs = new WeakMap();
  }

  _ensureFinalizationRegistry() {
    if (!this._weak || typeof FinalizationRegistry === 'undefined') return null;
    if (this._fr) return this._fr;

    this._fr = new FinalizationRegistry((token) => {
      try {
        const { event, ref } = token;
        const bucket = this._listeners.get(event);
        if (bucket && typeof bucket.delete === 'function') {
          bucket.delete(ref.deref ? ref.deref() : ref);
        }
      } catch (e) {
        /* ignore finalizer errors */
      }
    });

    return this._fr;
  }

  /**
   * Cleanup dead weak refs from internal listener sets.
   * Useful in tests or environments where FinalizationRegistry/GC is unavailable.
   */
  cleanup() {
    if (!this._weak) return;
    for (const [event, bucket] of this._listeners) {
      cleanupWeakRefs(bucket);
      if (bucket.size === 0) this._listeners.delete(event);
    }
  }

  _getBucket(event) {
    let bucket = this._listeners.get(event);
    if (!bucket) return null;

    if (bucket instanceof PowerSubscriberSet) return bucket;
    if (bucket && typeof bucket[Symbol.iterator] === 'function') {
      const migrated = new PowerSubscriberSet({
        maxListeners: this._maxListeners,
        weak: this._weak,
      });
      for (const entry of bucket) {
        const fn = entry && typeof entry.deref === 'function' ? entry.deref() : entry;
        if (fn) migrated.add(fn);
      }
      this._listeners.set(event, migrated);
      return migrated;
    }

    return null;
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {(payload:any)=>void} fn
   * @returns {() => void} unsubscribe
   */
  _registerWeakListener(fn, event) {
    const fr = this._ensureFinalizationRegistry();
    if (!fr || typeof WeakRef === 'undefined') return null;
    const ref = new WeakRef(fn);
    try {
      fr.register(fn, { event, ref }, ref);
      this._finalizationRefs.set(fn, ref);
    } catch (e) {
      /* ignore registration failures */
      return null;
    }
    return ref;
  }

  _unregisterWeakListener(fn) {
    if (!this._fr || !this._finalizationRefs.has(fn)) return;
    const ref = this._finalizationRefs.get(fn);
    try {
      this._fr.unregister(ref);
    } catch (e) {
      /* ignore */
    }
    this._finalizationRefs.delete(fn);
  }

  on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    let bucket = this._getBucket(event);
    if (!bucket) {
      bucket = new PowerSubscriberSet({ maxListeners: this._maxListeners, weak: this._weak });
      this._listeners.set(event, bucket);
    }

    const unsubscribe = bucket.add(fn);
    const ref = this._registerWeakListener(fn, event);
    if (ref) {
      return () => {
        unsubscribe();
        this._unregisterWeakListener(fn);
      };
    }
    return unsubscribe;
  }

  /**
   * Subscribe once to an event. Listener is removed after first invocation.
   * @param {string} event
   * @param {(payload:any)=>void} fn
   * @returns {() => void} unsubscribe
   */
  once(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    let bucket = this._getBucket(event);
    if (!bucket) {
      bucket = new PowerSubscriberSet({ maxListeners: this._maxListeners, weak: this._weak });
      this._listeners.set(event, bucket);
    }

    const unsubscribe = bucket.addOnce(fn);
    const ref = this._registerWeakListener(fn, event);
    if (ref) {
      return () => {
        unsubscribe();
        this._unregisterWeakListener(fn);
      };
    }
    return unsubscribe;
  }

  /**
   * Remove a specific listener for an event.
   * @param {string} event
   * @param {(payload:any)=>void} fn
   */
  off(event, fn) {
    const bucket = this._getBucket(event);
    if (!bucket) return;
    bucket.delete(fn);
    this._unregisterWeakListener(fn);
    if (bucket.size === 0) this._listeners.delete(event);
  }

  /**
   * Emit an event to all subscribers. Returns true if any listeners were notified.
   * Errors thrown by listeners are swallowed.
   * @param {string} event
   * @param {any} [payload]
   * @returns {boolean}
   */
  emit(event, payload) {
    const bucket = this._listeners.get(event);
    if (!bucket || bucket.size === 0) return false;

    if (bucket instanceof PowerSubscriberSet) {
      let notified = false;
      bucket.forEach((fn) => {
        notified = true;
        try {
          fn(payload);
        } catch (e) {
          // swallow subscriber errors
        }
      });
      if (bucket.size === 0) this._listeners.delete(event);
      return notified;
    }

    const hadEntries = bucket.size > 0;
    for (const entry of bucket) {
      const fn = entry && typeof entry.deref === 'function' ? entry.deref() : entry;
      if (!fn) {
        bucket.delete(entry);
        continue;
      }
      try {
        fn(payload);
      } catch (e) {
        // swallow subscriber errors
      }
    }
    if (bucket.size === 0) this._listeners.delete(event);
    return hadEntries;
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
    const bucket = this._listeners.get(event);
    if (!bucket) return [];
    if (bucket instanceof PowerSubscriberSet) return bucket.values();
    return Array.from(bucket)
      .map((entry) => (entry && typeof entry.deref === 'function' ? entry.deref() : entry))
      .filter(Boolean);
  }

  /**
   * Clear listeners for an event or all events when called without args.
   * @param {string} [event]
   */
  clear(event) {
    if (event === undefined) {
      this._listeners.clear();
      return;
    }
    this._listeners.delete(event);
  }
}

export default PowerEventBus;
