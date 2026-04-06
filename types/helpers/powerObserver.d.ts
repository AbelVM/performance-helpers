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
import { PowerSubscriberSet } from './powerSubscriberSet.js';
import { PowerScheduler } from './powerScheduler.js';
