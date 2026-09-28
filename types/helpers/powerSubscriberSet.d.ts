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
     * @param {{weak?: boolean, maxListeners?: number}} [options] - `weak` stores
     *   listeners behind `WeakRef`; `maxListeners` caps the set (`0` = unlimited).
     */
    constructor(options?: {
        weak?: boolean;
        maxListeners?: number;
    });
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
     * @returns {void}
     */
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
