import { assertLimitRequired, assertKnownOptions } from '../utils/options.js';
/**
 * Shared subscriber set helper used by event buses and observable stores.
 *
 * Supports optional weak references, once-listeners, and max listener counts.
 */
const ORIGINAL = Symbol('PowerSubscriberSet.original');

/**
 * @typedef {import('./jsdoc-types.js').SubscriberListener} SubscriberListener
 * @typedef {import('./jsdoc-types.js').SubscriberEntry} SubscriberEntry
 * @typedef {import('./jsdoc-types.js').PowerSubscriberSetOptions} PowerSubscriberSetOptions
 */

/**
 * Whether a stored entry is a weak reference rather than the listener itself.
 *
 * Exists as a named type guard so the union can be narrowed at each read
 * site. Written with `in` plus a `typeof` check because the original test was
 * `typeof entry?.deref === 'function'`, and the two agree for every entry this
 * set stores: `WeakRef.deref` is on the prototype, so `in` finds it, and a
 * plain listener has no `deref` at all.
 *
 * @param {SubscriberEntry} entry
 * @returns {entry is WeakRef<SubscriberListener>}
 */
function isWeakEntry(entry) {
  return 'deref' in entry && typeof entry.deref === 'function';
}

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
   * @param {PowerSubscriberSetOptions} [options] - `weak` stores listeners
   *   behind `WeakRef`; `maxListeners` caps the set (`0` = unlimited).
   */
  constructor(options = {}) {
    assertKnownOptions(options, ['weak', 'maxListeners'], 'PowerSubscriberSet');
    const { weak = false, maxListeners = 0 } = options || {};
    // `0` is the documented "unlimited"; see the note below the assignment.
    this._weak = Boolean(weak);
    // As in `PowerEventBus`: `0` is the documented "unlimited" and is kept, but
    // the old `Math.max(0, ...)` turned any negative into `0` - which here means
    // *no limit at all*, so a mistake made the cap disappear.
    this._maxListeners = assertLimitRequired(maxListeners, {
      name: 'maxListeners',
      className: 'PowerSubscriberSet',
      integer: true,
      min: 0,
      fallback: 0,
    });
    /** @type {Set<SubscriberEntry>} */
    this._listeners = new Set();
    /** @type {WeakMap<SubscriberListener, SubscriberListener>} original -> once-wrapper */
    this._onceMap = new WeakMap();
    /** @type {?(FinalizationRegistry<{ref: WeakRef<SubscriberListener>}>)} */
    this._finalization = this._ensureFinalization();
  }

  /** Number of currently live listeners. */
  get size() {
    this._cleanup();
    return this._listeners.size;
  }

  /**
   * Add a listener and return an unsubscribe function.
   * @param {SubscriberListener|WeakRef<SubscriberListener>} fn Listener function, or its WeakRef when `weak` mode is enabled.
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
   * @param {SubscriberListener} fn Listener function.
   * @returns {() => boolean} Unsubscribe function.
   */
  addOnce(fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    // The wrapper is tagged with the original listener under a module-private
    // symbol so a caller holding the wrapper can recover what it wraps.
    const wrapped = /** @type {((...args:any[])=>any) & {[ORIGINAL]?: SubscriberListener}} */ (
      (...args) => {
        try {
          // Returned, and that is load-bearing rather than tidy. Dropping it made
          // an `async` once-listener unobservable: the promise was discarded
          // inside this wrapper, so whatever called it had nothing to attach a
          // rejection handler to, and a listener that rejected reached the
          // process. `PowerEventBus.emit` is the caller that cares, and it
          // swallows rejections on purpose — but it can only do that if the
          // promise survives this frame.
          return fn(...args);
        } finally {
          this.delete(fn);
        }
      }
    );
    try {
      wrapped[ORIGINAL] = fn;
    } catch (e) {
      // ignore environments that disallow setting properties on functions
    }
    // Enforce maxListeners before mutating state so a rejected addOnce does
    // not leave a dangling `_onceMap` entry that a later `delete(fn)` would
    // resolve to a wrapper no longer present in `_listeners`.
    if (this._maxListeners > 0 && this.size + 1 > this._maxListeners) {
      throw new Error(
        `PowerSubscriberSet: adding listener exceeds maxListeners (${this._maxListeners})`
      );
    }
    this._onceMap.set(fn, wrapped);
    const entry = this._makeEntry(wrapped);
    this._listeners.add(entry);
    return () => this.delete(fn);
  }

  /**
   * Delete a listener by original function or once-wrapper.
   * @param {SubscriberListener|WeakRef<SubscriberListener>} fn Original listener function or its WeakRef wrapper.
   * @returns {boolean} `true` if a listener was removed, otherwise `false`.
   */
  delete(fn) {
    // `_onceMap` is keyed by the original *function*, so a WeakRef argument -
    // which `add` accepts in weak mode, and hands straight back to `delete` -
    // never has an entry there and must not be looked up.
    /** @type {SubscriberEntry} */
    let target = fn;
    if (!isWeakEntry(fn)) {
      const wrapped = this._onceMap.get(fn);
      if (wrapped) {
        target = wrapped;
        this._onceMap.delete(fn);
      }
    }

    for (const entry of this._listeners) {
      if (entry === target) {
        this._listeners.delete(entry);
        if (this._finalization && isWeakEntry(entry)) {
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
        if (this._finalization && isWeakEntry(entry)) {
          this._finalization.unregister(entry);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Iterate live listeners in insertion order and invoke a callback.
   * @param {(listener: SubscriberListener) => void} fn Callback invoked for each live listener.
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
   *
   * Also unregisters every token from the `FinalizationRegistry` and drops the
   * registry. Without that, `clear()` emptied `_listeners` while the registry
   * went on holding a live `FinalizationRegistry` whose held values are
   * `WeakRef`s to listeners that no longer belong to this set — so a
   * `dispose()`d subscriber set, released precisely *so it could be collected*,
   * stayed reachable through its own registry, and a later collection fired a
   * callback that closed over it. That is the opposite of what disposal is for,
   * and the `dispose()` JSDoc claimed the registry was replaced when it was not.
   *
   * @returns {void}
   */

  /**
   * Alias for {@link PowerSubscriberSet#clear}.
   *
   * `clear()` here empties the container, and "reset" is a natural second word
   * for exactly that - so a caller who reaches for `reset()` on this class gets
   * the obvious thing instead of a `TypeError`. No limiter gets this alias: for
   * `PowerThrottle` and `PowerPermitGate`, `reset()` *refills* and `clear()`
   * would read as the opposite, and the two are deliberately not synonyms.
   *
   * @returns {void}
   */
  reset() {
    this.clear();
  }

  clear() {
    if (this._finalization) {
      // `unregister` needs the exact token, which is the `WeakRef` stored in
      // `_listeners`, so read the entries *before* dropping them.
      for (const entry of this._listeners) {
        if (isWeakEntry(entry)) this._finalization.unregister(entry);
      }
      // Drop the registry itself. A set disposed and then reused is a caller
      // error, but if it happens `add()` rebuilds a fresh registry on its next
      // weak registration rather than writing into the discarded one.
      this._finalization = null;
    }
    this._listeners.clear();
    this._onceMap = new WeakMap();
  }

  /**
   * Return a safe array copy of live listeners.
   * @returns {SubscriberListener[]} Array of live listener functions.
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
   * @yields {SubscriberListener}
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
      if (isWeakEntry(entry) && !entry.deref()) {
        this._listeners.delete(entry);
      }
    }
  }

  /**
   * Wrap a listener for storage: a `WeakRef` in weak mode, the function itself
   * otherwise. Undefined when weak mode is on but the runtime has no `WeakRef`.
   *
   * @param {SubscriberListener} fn
   * @returns {SubscriberEntry}
   */
  _makeEntry(fn) {
    if (this._weak && typeof WeakRef !== 'undefined') {
      const ref = new WeakRef(fn);
      const fr = this._ensureFinalization();
      if (fr) {
        try {
          fr.register(fn, { ref }, ref);
        } catch (e) {
          // ignore registration failures
        }
      }
      return ref;
    }
    return fn;
  }

  /**
   * Lazily build the `FinalizationRegistry` that prunes collected weak
   * listeners, and return it — or `null` when weak mode is off or the runtime
   * has no `FinalizationRegistry`, which is the signal to skip registration.
   *
   * `clear()` drops the registry (that is the point of BUG-025), so this has to
   * be able to build a *new* one. Skipping the rebuild instead would silently
   * downgrade a cleared-and-reused set to GC-agnostic behaviour, where a dead
   * weak ref survives until some later `size`/iteration happens to sweep it.
   *
   * @returns {?(FinalizationRegistry<{ref: WeakRef<SubscriberListener>}>)}
   */
  _ensureFinalization() {
    if (this._finalization) return this._finalization;
    if (!this._weak || typeof WeakRef === 'undefined') return null;
    if (typeof FinalizationRegistry === 'undefined') return null;
    this._finalization = new FinalizationRegistry((token) => {
      this._listeners.delete(token.ref);
    });
    return this._finalization;
  }

  /**
   * Resolve a stored entry to the live listener, or `undefined` when the weak
   * target has been collected.
   *
   * @param {SubscriberEntry} entry
   * @returns {SubscriberListener|undefined}
   */
  _deref(entry) {
    return isWeakEntry(entry) ? entry.deref() : entry;
  }

  /**
   * Release every resource this instance holds: the listener registry is
   * emptied and the `FinalizationRegistry` is replaced, so its retained
   * callbacks become collectable.
   *
   * Idempotent, and safe to call while the instance is idle. Exists so the
   * instance works with `using` / `await using`.
   *
   * @returns {void}
   */
  dispose() {
    this.clear();
    // Neutralise `clear` so a second dispose (or a late callback) cannot run a
    // second teardown pass over an already-empty registry.
    this.clear = () => {};
  }

  /**
   * Alias for {@link dispose}, so `using set = new PowerSubscriberSet()`
   * releases the listeners at scope exit.
   * @returns {void}
   */
  [Symbol.dispose]() {
    this.dispose();
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
