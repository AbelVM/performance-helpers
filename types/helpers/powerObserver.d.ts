export class PowerObserver {
    /**
     * Create a new PowerObserver.
     * @param {*} initial Initial value
     * @param {PowerObserverOptions} options
     */
    constructor(initial: any, options?: PowerObserverOptions);
    _value: any;
    _subs: PowerSubscriberSet;
    _map: Function | null;
    _distinct: boolean;
    _scheduleMode: string;
    _pending: boolean;
    _pendingPrev: any;
    _pendingNext: any;
    _scheduler: PowerScheduler;
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
    /**
     * Set or replace the mapping function used for notifications.
     *
     * @param {?((value:any)=>any)} fn - `null` clears the mapping. Anything
     *   that is not a function and not `null` throws rather than silently
     *   disabling mapping, because a typo'd option is otherwise invisible.
     * @returns {void}
     */
    map(fn: ((value: any) => any) | null): void;
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
export type PowerObserverOptions = import("./jsdoc-types.js").PowerObserverOptions;
import { PowerSubscriberSet } from './powerSubscriberSet.js';
import { PowerScheduler } from './powerScheduler.js';
