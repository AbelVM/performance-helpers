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
    /** Add a listener and return an unsubscribe function. */
    add(fn: any): () => boolean;
    /** Add a once listener and return an unsubscribe function. */
    addOnce(fn: any): () => boolean;
    /** Delete a listener by original function or once-wrapper. */
    delete(fn: any): boolean;
    /** Clear all listeners. */
    clear(): void;
    /** Return a safe array copy of live listeners. */
    values(): any[];
    /** Remove dead weak refs from the set. */
    _cleanup(): void;
    _makeEntry(fn: any): any;
    _deref(entry: any): any;
    /** Iterate live listeners in insertion order. */
    [Symbol.iterator](): ArrayIterator<any>;
}
