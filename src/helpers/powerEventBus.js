import { assertLimitRequired, assertKnownOptions } from '../utils/options.js';
import { PowerSubscriberSet, cleanupWeakRefs } from './powerSubscriberSet.js';
import { neutralise } from '../utils/neutralise.js';

/**
 * PowerEventBus
 *
 * Typed micro event bus providing lightweight pub/sub for intra-process
 * coordination. Subscriber errors are swallowed to avoid breaking emitters —
 * both a synchronous throw and a rejection from a listener that returned a
 * promise, because an unobserved rejection reaches the process and Node's
 * default is to terminate it. See {@link notifyListener}.
 *
 * @class PowerEventBus
 */
/**
 * A bucket of listeners as the bus stores them. Always a `PowerSubscriberSet`
 * in practice - the plain-`Set` arm is the shape a bucket has to be before
 * `_getBucket` has migrated it, and `emit()`/`emitAsync()` still recognise it
 * so a bus that was poked from outside degrades instead of throwing.
 *
 * @typedef {PowerSubscriberSet|Set<SubscriberListener|WeakRef<SubscriberListener>>} EventBusBucket
 */

/**
 * @typedef {import('./jsdoc-types.js').PowerEventBusOptions} PowerEventBusOptions
 * @typedef {import('./jsdoc-types.js').SubscriberListener} SubscriberListener
 * @typedef {import('./jsdoc-types.js').EventBusWeakToken} EventBusWeakToken
 */
/**
 * Call a listener, swallowing both a synchronous throw and an asynchronous
 * rejection.
 *
 * A `try`/`catch` observes a synchronous throw and nothing else. An `async`
 * listener returns a promise, and a promise that rejects with nobody observing
 * it reaches the process: **Node's default `--unhandled-rejections=throw` since
 * v15 terminates the process.** So an `async` listener that threw killed its
 * host from inside what is documented as a fire-and-forget notification, and
 * both the class JSDoc and `emit`'s own doc claimed errors were swallowed. The
 * claim was true of the sync case and false of the async one, which is worse
 * than either being consistently true.
 *
 * The thenable check is one property access and allocates nothing on the sync
 * path — `result` is `undefined` for a listener that returns nothing, and that is
 * by far the common case. A handler is attached only when a listener actually
 * returned something awaitable.
 *
 * @param {SubscriberListener} fn
 * @param {any} payload
 * @returns {any} Whatever the listener returned, so a caller that *wants* to
 *   await it still can.
 */
function notifyListener(fn, payload) {
  /** @type {any} */
  let result;
  try {
    result = fn(payload);
  } catch {
    // Swallowed, and the listener is deliberately left subscribed: a listener
    // that throws is not the same as a listener that unsubscribed, and dropping
    // it would turn one bad event into a permanently missing one.
    return undefined;
  }
  if (result != null && typeof result.then === 'function') {
    // `then(undefined, handler)` rather than `catch(handler)`, which is not
    // available on every thenable.
    result.then(undefined, () => {});
  }
  return result;
}

/**
 * @template [T=Record<string, any>]
 */
export class PowerEventBus {
  /**
   * @param {PowerEventBusOptions} [options] - `maxListeners` caps listeners per
   *   event (`0`, the default, is unlimited); `weak` stores them behind
   *   `WeakRef`.
   */
  constructor(options = {}) {
    assertKnownOptions(options, ['maxListeners', 'weak'], 'PowerEventBus');
    /** @type {Map<string, EventBusBucket>} */
    this._listeners = new Map();
    // `0` means unlimited, which is a real configuration and is kept. What was
    // wrong was the guard around it: `maxListeners: -5` produced `0`, and `0`
    // means *unlimited*. So a typo'd or arithmetic-mangled limit silently
    // removed the cap entirely - the one failure mode where being permissive
    // makes the leak worse rather than better.
    this._maxListeners = assertLimitRequired(options.maxListeners, {
      name: 'maxListeners',
      className: 'PowerEventBus',
      min: 0,
      fallback: 0,
    });
    this._weak = Boolean(options.weak);
    /** @type {?(FinalizationRegistry<EventBusWeakToken>)} */
    this._fr = null;
    /** @type {WeakMap<SubscriberListener, Map<string, Set<WeakRef<SubscriberListener>>>>} */
    this._finalizationRefs = new WeakMap();
    /** @type {Map<string, Set<WeakRef<SubscriberListener>>>} */
    this._eventFinalizationRefs = new Map();
    /** @type {Map<string, EventBusBucket>} */
    this._wildcards = new Map();
  }

  /**
   * Check whether an event name is a wildcard pattern (contains `*`).
   * @param {string} event
   * @returns {boolean}
   * @private
   */
  _isWildcard(event) {
    return event.includes('*');
  }

  /**
   * Convert a wildcard pattern to a RegExp. `*` matches any sequence of
   * characters except `:` — the bus's own topic separator — so `user:*` matches
   * `user:login` but not `user:profile:name`.
   *
   * @param {string} pattern
   * @returns {RegExp}
   * @private
   */
  _wildcardRegex(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^:]*');
    return new RegExp(`^${escaped}$`);
  }

  /**
   * Lazily build the `FinalizationRegistry` that prunes collected weak
   * listeners. Returns `null` when weak mode is off or the runtime has no
   * `FinalizationRegistry`, which is the signal to skip registration entirely.
   *
   * @returns {?(FinalizationRegistry<EventBusWeakToken>)}
   */
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
    for (const [pattern, bucket] of this._wildcards) {
      cleanupWeakRefs(bucket);
      if (bucket.size === 0) {
        this._clearWeakListenerEvent(pattern);
        this._wildcards.delete(pattern);
      }
    }
  }

  /**
   * Subscribe to an event.
   * @param {keyof T & string} event - Event name to subscribe to. Supports
   *   wildcard patterns containing `*` (e.g. `user:*` matches `user:login`).
   * @param {(payload:any)=>void} fn - Listener function.
   * @returns {() => void} unsubscribe
   * @throws {TypeError} When `fn` is not a function.
   */
  on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    const isWildcard = this._isWildcard(event);
    const store = isWildcard ? this._wildcards : this._listeners;
    let bucket = this._getBucket(event, store);
    if (!bucket) {
      bucket = new PowerSubscriberSet({ maxListeners: this._maxListeners, weak: this._weak });
      store.set(event, bucket);
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

  /**
   * The live bucket for an event, migrating a legacy plain `Set` of listeners
   * into a `PowerSubscriberSet` the first time it is read.
   *
   * Nothing in this module writes a plain `Set`, so the migration branch is not
   * reachable from here - but `_listeners` is a public-ish field on a
   * long-lived object and the bus is documented as tolerant of a set that was
   * replaced externally, so it stays.
   *
   * @param {string} event
   * @param {Map<string, EventBusBucket>} [store] - Defaults to `_listeners`.
   * @returns {PowerSubscriberSet|null}
   */
  _getBucket(event, store = this._listeners) {
    const bucket = store.get(event);
    if (!bucket) return null;
    if (bucket instanceof PowerSubscriberSet) return bucket;

    const migrated = new PowerSubscriberSet({
      maxListeners: this._maxListeners,
      weak: this._weak,
    });
    for (const entry of bucket) {
      const fn = 'deref' in entry ? entry.deref() : entry;
      if (fn) migrated.add(fn);
    }
    store.set(event, migrated);
    return migrated;
  }

  /**
   * Track a weak listener with the bus's `FinalizationRegistry`, so the
   * bookkeeping sets can drop it when it is collected.
   *
   * @param {SubscriberListener} fn
   * @param {string} event
   * @returns {?WeakRef<SubscriberListener>} The registered ref, or `null` when
   *   weak mode is off or registration failed.
   */
  _registerWeakListener(fn, event) {
    const fr = this._ensureFinalizationRegistry();
    if (!fr || typeof WeakRef === 'undefined') return null;
    const ref = new WeakRef(fn);
    try {
      /** @type {EventBusWeakToken} */
      const token = { event, ref };
      fr.register(fn, token, ref);
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

  /**
   * Drop a weak listener's bookkeeping. With no `event`, every event it was
   * registered against is cleared.
   *
   * @param {SubscriberListener} fn
   * @param {string} [event]
   * @returns {void}
   */
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

  /**
   * Unregister every weak ref held for one event, and forget the event.
   *
   * @param {string} event
   * @returns {void}
   */
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
   * @param {keyof T & string} event - Supports wildcard patterns containing `*`.
   * @param {(payload:any)=>void} fn
   * @throws {TypeError} When `fn` is not a function.
   * @returns {() => void} unsubscribe
   */
  once(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    const isWildcard = this._isWildcard(event);
    const store = isWildcard ? this._wildcards : this._listeners;
    let bucket = this._getBucket(event, store);
    if (!bucket) {
      bucket = new PowerSubscriberSet({ maxListeners: this._maxListeners, weak: this._weak });
      store.set(event, bucket);
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
   * @param {keyof T & string} event - Supports wildcard patterns containing `*`.
   * @param {(payload:any)=>void} fn
   */
  off(event, fn) {
    const isWildcard = this._isWildcard(event);
    const store = isWildcard ? this._wildcards : this._listeners;
    const bucket = this._getBucket(event, store);
    if (!bucket) return;
    bucket.delete(fn);
    this._unregisterWeakListener(fn, event);
    if (bucket.size === 0) {
      this._clearWeakListenerEvent(event);
      store.delete(event);
    }
  }

  /**
   * Emit an event to all subscribers. Returns true if any listeners were notified.
   *
   * Errors thrown by listeners are swallowed, and so are rejections from
   * listeners that returned a promise — an `async` listener that throws will not
   * reach the process. See {@link notifyListener}, which is where both are
   * observed.
   *
   * @param {keyof T & string} event
   * @param {any} [payload]
   * @returns {boolean}
   */
  emit(event, payload) {
    let notified = false;

    // Direct listeners
    const bucket = this._listeners.get(event);
    if (bucket && bucket.size > 0) {
      if (bucket instanceof PowerSubscriberSet) {
        for (const fn of bucket.values()) {
          notified = true;
          notifyListener(fn, payload);
        }
        if (bucket.size === 0) {
          this._clearWeakListenerEvent(event);
          this._listeners.delete(event);
        }
      } else {
        const hadEntries = bucket.size > 0;
        for (const entry of [...bucket]) {
          const fn = 'deref' in entry ? entry.deref() : entry;
          if (!fn) {
            bucket.delete(entry);
            continue;
          }
          notified = true;
          notifyListener(fn, payload);
        }
        if (bucket.size === 0) {
          this._clearWeakListenerEvent(event);
          this._listeners.delete(event);
        }
        if (hadEntries) notified = true;
      }
    }

    // Wildcard listeners
    for (const [pattern, wBucket] of this._wildcards) {
      if (!this._wildcardRegex(pattern).test(event)) continue;
      if (wBucket.size === 0) continue;
      if (wBucket instanceof PowerSubscriberSet) {
        for (const fn of wBucket.values()) {
          notified = true;
          notifyListener(fn, payload);
        }
        if (wBucket.size === 0) {
          this._clearWeakListenerEvent(pattern);
          this._wildcards.delete(pattern);
        }
      } else {
        for (const entry of [...wBucket]) {
          const fn = 'deref' in entry ? entry.deref() : entry;
          if (!fn) {
            wBucket.delete(entry);
            continue;
          }
          notified = true;
          notifyListener(fn, payload);
        }
        if (wBucket.size === 0) {
          this._clearWeakListenerEvent(pattern);
          this._wildcards.delete(pattern);
        }
      }
    }

    return notified;
  }

  /**
   * Iterate live listener functions from a bucket without allocating snapshots.
   * @private
   * @param {EventBusBucket} bucket
   * @yields {SubscriberListener}
   */
  *_iterBucketListeners(bucket) {
    if (bucket instanceof PowerSubscriberSet) {
      yield* bucket;
      return;
    }

    for (const entry of bucket) {
      const fn = 'deref' in entry ? entry.deref() : entry;
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
   * @param {keyof T & string} event
   * @param {any} [payload]
   * @param {{concurrency?: number}} [options] - `concurrency` caps how many
   *   listeners are awaited at once (`Infinity`, the default, is unbounded).
   * @returns {Promise<boolean>}
   */
  async emitAsync(event, payload, { concurrency = Infinity } = {}) {
    const bucket = this._listeners.get(event);
    if ((!bucket || bucket.size === 0) && this._wildcards.size === 0) return false;

    const normalizeConcurrency =
      Number.isFinite(+concurrency) && +concurrency > 0
        ? Math.max(1, Math.floor(+concurrency))
        : Infinity;

    /** @param {SubscriberListener} fn */
    const invoke = async (fn) => {
      try {
        await fn(payload);
      } catch (e) {
        // swallow subscriber errors
      }
    };

    const inFlight = new Set();
    let notified = false;

    /** @param {EventBusBucket} b @param {string} evt */
    const processBucket = async (b, evt) => {
      for (const fn of this._iterBucketListeners(b)) {
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

      if (b.size === 0) {
        this._clearWeakListenerEvent(evt);
        this._listeners.delete(evt);
      }
    };

    if (bucket && bucket.size > 0) {
      await processBucket(bucket, event);
    }

    for (const [pattern, wBucket] of this._wildcards) {
      if (!this._wildcardRegex(pattern).test(event)) continue;
      if (wBucket.size === 0) continue;
      await processBucket(wBucket, pattern);
    }

    if (inFlight.size) await Promise.all(inFlight);

    return notified;
  }

  /**
   * Return array of listeners for an event (copy).
   * @param {keyof T & string} event
   * @returns {SubscriberListener[]}
   */
  listeners(event) {
    const result = [];
    const bucket = this._listeners.get(event);
    if (bucket) {
      if (bucket instanceof PowerSubscriberSet) {
        result.push(...bucket.values());
      } else {
        for (const entry of bucket) {
          const fn = 'deref' in entry ? entry.deref() : entry;
          if (fn) result.push(fn);
        }
      }
    }
    for (const [pattern, wBucket] of this._wildcards) {
      if (!this._wildcardRegex(pattern).test(event)) continue;
      if (wBucket instanceof PowerSubscriberSet) {
        result.push(...wBucket.values());
      } else {
        for (const entry of wBucket) {
          const fn = 'deref' in entry ? entry.deref() : entry;
          if (fn) result.push(fn);
        }
      }
    }
    return result;
  }

  /**
   * Clear listeners for an event or all events when called without args.
   * @param {keyof T & string} [event]
   */
  clear(event) {
    if (event === undefined) {
      for (const ev of this._eventFinalizationRefs.keys()) this._clearWeakListenerEvent(ev);
      this._eventFinalizationRefs.clear();
      this._finalizationRefs = new WeakMap();
      this._listeners.clear();
      this._wildcards.clear();
      return;
    }
    this._clearWeakListenerEvent(event);
    this._listeners.delete(event);
    for (const [pattern] of this._wildcards) {
      if (this._wildcardRegex(pattern).test(event)) {
        this._clearWeakListenerEvent(pattern);
        this._wildcards.delete(pattern);
      }
    }
  }

  /**
   * Alias for {@link PowerEventBus#clear}.
   *
   * `clear()` here empties the container, and "reset" is a natural second word
   * for exactly that - so a caller who reaches for `reset()` on this class gets
   * the obvious thing instead of a `TypeError`. No limiter gets this alias: for
   * `PowerThrottle` and `PowerPermitGate`, `reset()` *refills* and `clear()`
   * would read as the opposite, and the two are deliberately not synonyms.
   *
   * @param {keyof T & string} [event] - Passed through to `clear()`; clears just that
   *   event's listeners when given, and every listener when omitted.
   * @returns {void}
   */
  reset(event) {
    this.clear(event);
  }

  /**
   * Release every listener, and reset the `FinalizationRegistry` so the
   * registry's retained callbacks become garbage.
   *
   * Idempotent, and safe to call while the bus is idle. Exists so a bus works
   * with `using` / `await using` (see the `Symbol.dispose` alias below)
   * and gives callers an explicit name to call.
   *
   * @returns {void}
   */
  dispose() {
    this.clear();
    // Neutralise `clear` so a second dispose, or a late callback, cannot run a
    // second teardown pass over an already-empty bus.
    neutralise(this, 'clear');
  }

  /**
   * Alias for {@link PowerEventBus#dispose}, so `using bus = new PowerEventBus()`
   * releases the listeners and the finalization registry at scope exit.
   * @returns {void}
   */
  [Symbol.dispose]() {
    this.dispose();
  }

  /**
   * Asynchronous disposal hook (thin wrapper). Forwards to sync disposal.
   * @returns {Promise<void>}
   */
  async [Symbol.asyncDispose]() {
    this.dispose();
    return;
  }
}

export default PowerEventBus;
