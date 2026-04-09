/**
 * Cleanup dead weak refs from a subscriber bucket.
 * @param {any} bucket
 */
export function cleanupWeakRefs(bucket: any): void;
export class PowerSubscriberSet {
    /**
     * @param {Object} [options]
     * @param {boolean} [options.weak=false]
     * @param {number} [options.maxListeners=0]
     */
    constructor(options?: {
        weak?: boolean | undefined;
        maxListeners?: number | undefined;
    });
    _weak: boolean;
    _maxListeners: number;
    _listeners: Set<any>;
    _onceMap: WeakMap<object, any>;
    _finalization: any;
    /** Number of currently live listeners. */
    get size(): number;
    /**
     * Add a listener and return an unsubscribe function.
     * @param {Function|WeakRef} fn Listener function or WeakRef when `weak` mode is enabled.
     * @returns {() => boolean} Unsubscribe function that removes the listener.
     */
    add(fn: Function | WeakRef): () => boolean;
    /**
     * Add a once listener and return an unsubscribe function.
     * The original listener will be removed after the first invocation.
     * @param {Function} fn Listener function.
     * @returns {() => boolean} Unsubscribe function.
     */
    addOnce(fn: Function): () => boolean;
    /**
     * Delete a listener by original function or once-wrapper.
     * @param {Function|WeakRef} fn Original listener function or its WeakRef wrapper.
     * @returns {boolean} `true` if a listener was removed, otherwise `false`.
     */
    delete(fn: Function | WeakRef): boolean;
    /**
     * Iterate live listeners in insertion order and invoke a callback.
     * @param {(listener: Function) => void} fn Callback invoked for each live listener.
     * @returns {void}
     */
    forEach(fn: (listener: Function) => void): void;
    /**
     * Clear all listeners.
     * @returns {void}
     */
    clear(): void;
    /**
     * Return a safe array copy of live listeners.
     * @returns {Function[]} Array of live listener functions.
     */
    values(): Function[];
    /** Remove dead weak refs from the set. */
    _cleanup(): void;
    _makeEntry(fn: any): any;
    _deref(entry: any): any;
    /**
     * Iterate live listeners in insertion order.
     * @yields {Function}
     */
    [Symbol.iterator](): Generator<any, void, unknown>;
}
