/**
 * Cleanup dead weak refs from a subscriber bucket.
 *
 * @public
 * @param {any} bucket
 */
export function cleanupWeakRefs(bucket: any): void;
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
    constructor(options?: PowerSubscriberSetOptions);
    _weak: boolean;
    _maxListeners: number;
    /** @type {Set<SubscriberEntry>} */
    _listeners: Set<SubscriberEntry>;
    /** @type {WeakMap<SubscriberListener, SubscriberListener>} original -> once-wrapper */
    _onceMap: WeakMap<SubscriberListener, SubscriberListener>;
    /** @type {?(FinalizationRegistry<{ref: WeakRef<SubscriberListener>}>)} */
    _finalization: (FinalizationRegistry<{
        ref: WeakRef<SubscriberListener>;
    }>) | null;
    /** Number of currently live listeners. */
    get size(): number;
    /**
     * Add a listener and return an unsubscribe function.
     * @param {SubscriberListener|WeakRef<SubscriberListener>} fn Listener function, or its WeakRef when `weak` mode is enabled.
     * @returns {() => boolean} Unsubscribe function that removes the listener.
     */
    add(fn: SubscriberListener | WeakRef<SubscriberListener>): () => boolean;
    /**
     * Add a once listener and return an unsubscribe function.
     * The original listener will be removed after the first invocation.
     * @param {SubscriberListener} fn Listener function.
     * @returns {() => boolean} Unsubscribe function.
     */
    addOnce(fn: SubscriberListener): () => boolean;
    /**
     * Delete a listener by original function or once-wrapper.
     * @param {SubscriberListener|WeakRef<SubscriberListener>} fn Original listener function or its WeakRef wrapper.
     * @returns {boolean} `true` if a listener was removed, otherwise `false`.
     */
    delete(fn: SubscriberListener | WeakRef<SubscriberListener>): boolean;
    /**
     * Iterate live listeners in insertion order and invoke a callback.
     * @param {(listener: SubscriberListener) => void} fn Callback invoked for each live listener.
     * @returns {void}
     */
    forEach(fn: (listener: SubscriberListener) => void): void;
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
    reset(): void;
    clear(): void;
    /**
     * Return a safe array copy of live listeners.
     * @returns {SubscriberListener[]} Array of live listener functions.
     */
    values(): SubscriberListener[];
    /** Remove dead weak refs from the set. */
    _cleanup(): void;
    /**
     * Wrap a listener for storage: a `WeakRef` in weak mode, the function itself
     * otherwise. Undefined when weak mode is on but the runtime has no `WeakRef`.
     *
     * @param {SubscriberListener} fn
     * @returns {SubscriberEntry}
     */
    _makeEntry(fn: SubscriberListener): SubscriberEntry;
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
    _ensureFinalization(): (FinalizationRegistry<{
        ref: WeakRef<SubscriberListener>;
    }>) | null;
    /**
     * Resolve a stored entry to the live listener, or `undefined` when the weak
     * target has been collected.
     *
     * @param {SubscriberEntry} entry
     * @returns {SubscriberListener|undefined}
     */
    _deref(entry: SubscriberEntry): SubscriberListener | undefined;
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
    dispose(): void;
    /**
     * Iterate live listeners in insertion order.
     * @yields {SubscriberListener}
     */
    [Symbol.iterator](): Generator<import("./jsdoc-types.js").SubscriberListener, void, unknown>;
    /**
     * Alias for {@link dispose}, so `using set = new PowerSubscriberSet()`
     * releases the listeners at scope exit.
     * @returns {void}
     */
    [Symbol.dispose](): void;
}
export type SubscriberListener = import("./jsdoc-types.js").SubscriberListener;
export type SubscriberEntry = import("./jsdoc-types.js").SubscriberEntry;
export type PowerSubscriberSetOptions = import("./jsdoc-types.js").PowerSubscriberSetOptions;
