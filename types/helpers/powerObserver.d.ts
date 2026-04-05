/**
 * Lightweight reactive value store.
 * Subscribers are called synchronously when the value changes.
 *
 * Example:
 * const obs = new PowerObserver(42);
 * obs.subscribe((next, prev) => console.log(next, prev));
 * obs.value = 99;
 */
/**
 * @typedef {Object} PowerObserverOptions
 * @property {function} [map]
 * @property {boolean} [distinct]
 * @property {boolean|'microtask'|'macrotask'} [async]
 */
export class PowerObserver {
    /**
     * Create a new PowerObserver.
     * @param {*} initial Initial value
     * @param {PowerObserverOptions} options
     */
    constructor(initial: any, options?: PowerObserverOptions);
    _value: any;
    /** @type {Set<Function>} */
    _subs: Set<Function>;
    _map: Function | null;
    _distinct: boolean;
    _scheduleMode: string;
    _pending: boolean;
    _pendingPrev: any;
    _pendingNext: any;
    _pendingTimer: number | null;
    /** Set value and schedule notification according to `async` option */
    set value(v: any);
    /** Current value */
    get value(): any;
    /**
     * Subscribe to changes. Returns an unsubscribe function.
     * @param {(next:any, prev:any)=>void} fn
     */
    subscribe(fn: (next: any, prev: any) => void): () => boolean;
    /** Remove all subscribers */
    clear(): void;
    /** Number of subscribers */
    get size(): number;
    /** Set or replace the mapping function used for notifications */
    map(fn: any): void;
    /**
     * Flush any pending notification immediately. Useful for tests or shutdown.
     */
    flush(): void;
    /** Alias for flush() */
    drain(): void;
    /** Internal flush implementation */
    _flushPending(): void;
}
export default PowerObserver;
export type PowerObserverOptions = {
    map?: Function | undefined;
    distinct?: boolean | undefined;
    async?: boolean | "microtask" | "macrotask" | undefined;
};
