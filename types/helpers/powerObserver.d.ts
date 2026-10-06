export class PowerObserver {
    /**
     * Combine several observers into one that emits whenever **any** of them
     * changes, with the latest value of each.
     *
     * ```js
     * const both = PowerObserver.combineLatest(a, b); // [a.value, b.value]
     * ```
     *
     * Like every derived observer, it subscribes upstream on first use and releases
     * on last unsubscribe.
     *
     * @param {...PowerObserver} sources
     * @returns {PowerObserver}
     */
    static combineLatest(...sources: PowerObserver[]): PowerObserver;
    /**
     * Create a new PowerObserver.
     * @param {*} initial Initial value
     * @param {PowerObserverOptions} options
     */
    constructor(initial: any, options?: PowerObserverOptions);
    /** @type {*} */
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
     * Create a **computed** observer: a new observer whose value is recomputed from
     * this one, and which only exists as long as something subscribes to it.
     *
     * This is the explicit counterpart to `derive()` for values that are pure
     * computations of the source. The upstream subscription is created on first
     * subscribe and released on last unsubscribe.
     *
     * @param {(value:any, prev:any)=>any} fn - Compute the next value.
     * @returns {PowerObserver} A new observer, already holding `fn(this.value)`.
     */
    computed(fn: (value: any, prev: any) => any): PowerObserver;
    /**
     * Run a side-effect whenever the value changes. The effect is subscribed
     * immediately and runs on the next change (including the initial change if
     * the value is set after `effect()` is called).
     *
     * If the effect function returns a function, that function is treated as a
     * cleanup and is called before the next effect invocation and when the
     * effect is disposed.
     *
     * @param {(next:any, prev:any)=>void|(()=>void)} fn - Side-effect to run.
     * @returns {() => void} dispose function that unsubscribes and runs cleanup.
     */
    effect(fn: (next: any, prev: any) => void | (() => void)): () => void;
    /**
     * Create a **derived** observer: a new observer whose value is recomputed from
     * this one, and which only exists as long as something subscribes to it.
     *
     * `map()` *mutates* this observer's mapping and returns nothing; this is the
     * pure counterpart, so chains can be built without disturbing the source.
     *
     * ```js
     * const label = user.derive((u) => u.name).filter((n) => n.length > 0);
     * const off = label.subscribe((name) => render(name));
     * ```
     *
     * **The upstream subscription is created on first subscribe and released on
     * last unsubscribe.** That is the whole difficulty with derived observables
     * and the reason a naive version leaks: a chain of ten `derive` calls held by
     * one consumer keeps all ten upstreams alive, and a consumer that unsubscribes
     * and is collected leaves every one of them running. Nothing is subscribed
     * until someone asks, and everything is released when they stop.
     *
     * **While nobody is subscribed, the derived value is a snapshot, not a live
     * value** — the value captured when the chain was built. That is the direct
     * cost of not subscribing, and it is why a consumer that wants a live value has
     * to subscribe.
     *
     * @param {(value:any, prev:any)=>any} fn - Derive the next value.
     * @returns {PowerObserver} A new observer, already holding `fn(this.value)`.
     */
    derive(fn: (value: any, prev: any) => any): PowerObserver;
    /**
     * Only notify subscribers when `predicate` passes. The derived value is the
     * last value that *passed*, so a filtered stream cannot be read as "the latest
     * upstream value".
     *
     * @param {(value:any, prev:any)=>boolean} predicate
     * @returns {PowerObserver}
     */
    filter(predicate: (value: any, prev: any) => boolean): PowerObserver;
    /**
     * Only notify when the value actually changes, using `Object.is` so `NaN`
     * equals itself and `-0` does not equal `0`. This is per-derived-observer and
     * does not change the source, unlike the `distinct` constructor option.
     *
     * @returns {PowerObserver}
     */
    distinct(): PowerObserver;
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
