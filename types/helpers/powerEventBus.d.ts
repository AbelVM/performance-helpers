/**
 * PowerEventBus
 *
 * Typed micro event bus providing lightweight pub/sub for intra-process
 * coordination. Subscriber errors are swallowed to avoid breaking emitters.
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
export class PowerEventBus {
    /**
     * @param {PowerEventBusOptions} [options] - `maxListeners` caps listeners per
     *   event (`0`, the default, is unlimited); `weak` stores them behind
     *   `WeakRef`.
     */
    constructor(options?: PowerEventBusOptions);
    /** @type {Map<string, EventBusBucket>} */
    _listeners: Map<string, EventBusBucket>;
    _maxListeners: number;
    _weak: boolean;
    /** @type {?(FinalizationRegistry<EventBusWeakToken>)} */
    _fr: (FinalizationRegistry<EventBusWeakToken>) | null;
    /** @type {WeakMap<SubscriberListener, Map<string, Set<WeakRef<SubscriberListener>>>>} */
    _finalizationRefs: WeakMap<SubscriberListener, Map<string, Set<WeakRef<SubscriberListener>>>>;
    /** @type {Map<string, Set<WeakRef<SubscriberListener>>>} */
    _eventFinalizationRefs: Map<string, Set<WeakRef<SubscriberListener>>>;
    /**
     * Lazily build the `FinalizationRegistry` that prunes collected weak
     * listeners. Returns `null` when weak mode is off or the runtime has no
     * `FinalizationRegistry`, which is the signal to skip registration entirely.
     *
     * @returns {?(FinalizationRegistry<EventBusWeakToken>)}
     */
    _ensureFinalizationRegistry(): (FinalizationRegistry<EventBusWeakToken>) | null;
    /**
     * Cleanup dead weak refs from internal listener sets.
     * Useful in tests or environments where FinalizationRegistry/GC is unavailable.
     *
     * @returns {void}
     */
    cleanup(): void;
    /**
     * Subscribe to an event.
     * @param {string} event - Event name to subscribe to.
     * @param {(payload:any)=>void} fn - Listener function.
     * @returns {() => void} unsubscribe
     * @throws {TypeError} When `fn` is not a function.
     */
    on(event: string, fn: (payload: any) => void): () => void;
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
     * @returns {PowerSubscriberSet|null}
     */
    _getBucket(event: string): PowerSubscriberSet | null;
    /**
     * Track a weak listener with the bus's `FinalizationRegistry`, so the
     * bookkeeping sets can drop it when it is collected.
     *
     * @param {SubscriberListener} fn
     * @param {string} event
     * @returns {?WeakRef<SubscriberListener>} The registered ref, or `null` when
     *   weak mode is off or registration failed.
     */
    _registerWeakListener(fn: SubscriberListener, event: string): WeakRef<SubscriberListener> | null;
    /**
     * Drop a weak listener's bookkeeping. With no `event`, every event it was
     * registered against is cleared.
     *
     * @param {SubscriberListener} fn
     * @param {string} [event]
     * @returns {void}
     */
    _unregisterWeakListener(fn: SubscriberListener, event?: string): void;
    /**
     * Unregister every weak ref held for one event, and forget the event.
     *
     * @param {string} event
     * @returns {void}
     */
    _clearWeakListenerEvent(event: string): void;
    /**
     * Subscribe once to an event. Listener is removed after first invocation.
     * @param {string} event
     * @param {(payload:any)=>void} fn
     * @throws {TypeError} When `fn` is not a function.
     * @returns {() => void} unsubscribe
     */
    once(event: string, fn: (payload: any) => void): () => void;
    /**
     * Remove a specific listener for an event.
     * @param {string} event
     * @param {(payload:any)=>void} fn
     */
    off(event: string, fn: (payload: any) => void): void;
    /**
     * Emit an event to all subscribers. Returns true if any listeners were notified.
     * Errors thrown by listeners are swallowed.
     * @param {string} event
     * @param {any} [payload]
     * @returns {boolean}
     */
    emit(event: string, payload?: any): boolean;
    /**
     * Iterate live listener functions from a bucket without allocating snapshots.
     * @private
     * @param {EventBusBucket} bucket
     * @yields {SubscriberListener}
     */
    private _iterBucketListeners;
    /**
     * Emit an event to all subscribers and await async listeners.
     * Supports bounded concurrency so long listener lists can be processed in
     * batches without flooding the event loop.
     * Errors thrown or rejected by listeners are swallowed.
     * @param {string} event
     * @param {any} [payload]
     * @param {{concurrency?: number}} [options] - `concurrency` caps how many
     *   listeners are awaited at once (`Infinity`, the default, is unbounded).
     * @returns {Promise<boolean>}
     */
    emitAsync(event: string, payload?: any, { concurrency }?: {
        concurrency?: number;
    }): Promise<boolean>;
    /**
     * Return array of listeners for an event (copy).
     * @param {string} event
     * @returns {SubscriberListener[]}
     */
    listeners(event: string): SubscriberListener[];
    /**
     * Clear listeners for an event or all events when called without args.
     * @param {string} [event]
     */
    clear(event?: string): void;
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
    dispose(): void;
    /**
     * Alias for {@link PowerEventBus#dispose}, so `using bus = new PowerEventBus()`
     * releases the listeners and the finalization registry at scope exit.
     * @returns {void}
     */
    [Symbol.dispose](): void;
}
export default PowerEventBus;
/**
 * A bucket of listeners as the bus stores them. Always a `PowerSubscriberSet`
 * in practice - the plain-`Set` arm is the shape a bucket has to be before
 * `_getBucket` has migrated it, and `emit()`/`emitAsync()` still recognise it
 * so a bus that was poked from outside degrades instead of throwing.
 */
export type EventBusBucket = PowerSubscriberSet | Set<SubscriberListener | WeakRef<SubscriberListener>>;
export type PowerEventBusOptions = import("./jsdoc-types.js").PowerEventBusOptions;
export type SubscriberListener = import("./jsdoc-types.js").SubscriberListener;
export type EventBusWeakToken = import("./jsdoc-types.js").EventBusWeakToken;
import { PowerSubscriberSet } from './powerSubscriberSet.js';
