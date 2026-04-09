import { PowerSubscriberSet, cleanupWeakRefs } from './powerSubscriberSet.js';

/**
 * PowerEventBus
 *
 * Typed micro event bus providing lightweight pub/sub for intra-process
 * coordination. Subscriber errors are swallowed to avoid breaking emitters.
 *
 * @class PowerEventBus
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
    // fn -> Map<event, Set<WeakRef>>
    this._finalizationRefs = new WeakMap();
    // event -> Set<WeakRef>
    this._eventFinalizationRefs = new Map();
  }

  _ensureFinalizationRegistry() {
    if (!this._weak || typeof FinalizationRegistry === 'undefined') return null;
    if (this._fr) return this._fr;

    this._fr = new FinalizationRegistry((token) => {
      try {
        const { event, ref } = token;
        const bucket = this._listeners.get(event);
        const refsByEvent = this._eventFinalizationRefs.get(event);
        if (refsByEvent && ref) {
          refsByEvent.delete(ref);
          if (refsByEvent.size === 0) this._eventFinalizationRefs.delete(event);
        }
        if (!bucket) return;
        cleanupWeakRefs(bucket);
        if (bucket.size === 0) {
          this._listeners.delete(event);
          this._eventFinalizationRefs.delete(event);
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
   *
   * @returns {void}
   */
  cleanup() {
    if (!this._weak) return;
    for (const [event, bucket] of this._listeners) {
      cleanupWeakRefs(bucket);
      if (bucket.size === 0) {
        this._clearWeakListenerEvent(event);
        this._listeners.delete(event);
      }
    }
  }

  /**
   * Subscribe to an event.
   * @param {string} event - Event name to subscribe to.
   * @param {(payload:any)=>void} fn - Listener function.
   * @returns {() => void} unsubscribe
   * @throws {TypeError} When `fn` is not a function.
   */
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
        this._unregisterWeakListener(fn, event);
      };
    }
    return unsubscribe;
  }

  _getBucket(event) {
    let bucket = this._listeners.get(event);
    if (!bucket) return null;

    if (bucket instanceof PowerSubscriberSet) return bucket;
    if (typeof bucket?.[Symbol.iterator] === 'function') {
      const migrated = new PowerSubscriberSet({
        maxListeners: this._maxListeners,
        weak: this._weak,
      });
      for (const entry of bucket) {
        const fn = typeof entry?.deref === 'function' ? entry.deref() : entry;
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
      let perFn = this._finalizationRefs.get(fn);
      if (!perFn) {
        perFn = new Map();
        this._finalizationRefs.set(fn, perFn);
      }
      let refsForEvent = perFn.get(event);
      if (!refsForEvent) {
        refsForEvent = new Set();
        perFn.set(event, refsForEvent);
      }
      refsForEvent.add(ref);

      let refsByEvent = this._eventFinalizationRefs.get(event);
      if (!refsByEvent) {
        refsByEvent = new Set();
        this._eventFinalizationRefs.set(event, refsByEvent);
      }
      refsByEvent.add(ref);
    } catch (e) {
      /* ignore registration failures */
      return null;
    }
    return ref;
  }

  _unregisterWeakListener(fn, event) {
    if (!this._fr || !this._finalizationRefs.has(fn)) return;
    const perFn = this._finalizationRefs.get(fn);
    if (!perFn || perFn.size === 0) {
      this._finalizationRefs.delete(fn);
      return;
    }

    const events = event !== undefined ? [event] : Array.from(perFn.keys());
    for (const ev of events) {
      const refs = perFn.get(ev);
      if (!refs || refs.size === 0) {
        perFn.delete(ev);
        continue;
      }

      for (const ref of refs) {
        try {
          this._fr.unregister(ref);
        } catch (e) {
          /* ignore */
        }
        const byEvent = this._eventFinalizationRefs.get(ev);
        if (byEvent) {
          byEvent.delete(ref);
          if (byEvent.size === 0) this._eventFinalizationRefs.delete(ev);
        }
      }
      perFn.delete(ev);
    }

    if (perFn.size === 0) this._finalizationRefs.delete(fn);
  }

  _clearWeakListenerEvent(event) {
    if (!this._fr) return;
    const refs = this._eventFinalizationRefs.get(event);
    if (!refs) return;
    for (const ref of refs) {
      try {
        this._fr.unregister(ref);
      } catch (e) {
        /* ignore */
      }
    }
    this._eventFinalizationRefs.delete(event);
  }

  /**
   * Subscribe once to an event. Listener is removed after first invocation.
   * @param {string} event
   * @param {(payload:any)=>void} fn
   * @throws {TypeError} When `fn` is not a function.
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
        this._unregisterWeakListener(fn, event);
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
    this._unregisterWeakListener(fn, event);
    if (bucket.size === 0) {
      this._clearWeakListenerEvent(event);
      this._listeners.delete(event);
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
      if (bucket.size === 0) {
        this._clearWeakListenerEvent(event);
        this._listeners.delete(event);
      }
      return notified;
    }

    const hadEntries = bucket.size > 0;
    for (const entry of bucket) {
      const fn = typeof entry?.deref === 'function' ? entry.deref() : entry;
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
    if (bucket.size === 0) {
      this._clearWeakListenerEvent(event);
      this._listeners.delete(event);
    }
    return hadEntries;
  }

  /**
   * Iterate live listener functions from a bucket without allocating snapshots.
   * @private
   * @param {PowerSubscriberSet|Set<any>} bucket
   */
  *_iterBucketListeners(bucket) {
    if (bucket instanceof PowerSubscriberSet) {
      yield* bucket;
      return;
    }

    for (const entry of bucket) {
      const fn = typeof entry?.deref === 'function' ? entry.deref() : entry;
      if (!fn) {
        bucket.delete(entry);
        continue;
      }
      yield fn;
    }
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
    const bucket = this._listeners.get(event);
    if (!bucket || bucket.size === 0) return false;

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

    const inFlight = new Set();
    let notified = false;

    for (const fn of this._iterBucketListeners(bucket)) {
      if (!fn) continue;
      notified = true;
      const p = Promise.resolve()
        .then(() => invoke(fn))
        .finally(() => {
          inFlight.delete(p);
        });
      inFlight.add(p);

      if (Number.isFinite(normalizeConcurrency) && inFlight.size >= normalizeConcurrency) {
        await Promise.race(inFlight);
      }
    }

    if (inFlight.size) await Promise.all(inFlight);

    if (bucket.size === 0) {
      this._clearWeakListenerEvent(event);
      this._listeners.delete(event);
    }

    return notified;
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
      .map((entry) => (typeof entry?.deref === 'function' ? entry.deref() : entry))
      .filter(Boolean);
  }

  /**
   * Clear listeners for an event or all events when called without args.
   * @param {string} [event]
   */
  clear(event) {
    if (event === undefined) {
      for (const ev of this._eventFinalizationRefs.keys()) this._clearWeakListenerEvent(ev);
      this._eventFinalizationRefs.clear();
      this._finalizationRefs = new WeakMap();
      this._listeners.clear();
      return;
    }
    this._clearWeakListenerEvent(event);
    this._listeners.delete(event);
  }
}

export default PowerEventBus;
