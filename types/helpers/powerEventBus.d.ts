/**
 * Typed micro event bus.
 * Lightweight pub/sub for intra-process coordination.
 * Subscriber errors are swallowed to avoid breaking emitters.
 */
/**
 * @typedef {Object} PowerEventBusOptions
 * @property {number} [maxListeners]
 * @property {boolean} [weak]
 */
export class PowerEventBus {
    /**
     * @param {{maxListeners?: number, weak?: boolean}=} options
     */
    constructor(options?: {
        maxListeners?: number;
        weak?: boolean;
    } | undefined);
    _listeners: Map<any, any>;
    _maxListeners: number;
    _weak: boolean;
    _fr: any;
    _finalizationRefs: WeakMap<object, any>;
    _ensureFinalizationRegistry(): any;
    /**
     * Cleanup dead weak refs from internal listener sets.
     * Useful in tests or environments where FinalizationRegistry/GC is unavailable.
     */
    cleanup(): void;
    _getBucket(event: any): PowerSubscriberSet | null;
    /**
     * Subscribe to an event.
     * @param {string} event
     * @param {(payload:any)=>void} fn
     * @returns {() => void} unsubscribe
     */
    _registerWeakListener(fn: (payload: any) => void, event: string): () => void;
    _unregisterWeakListener(fn: any): void;
    on(event: any, fn: any): () => void;
    /**
     * Subscribe once to an event. Listener is removed after first invocation.
     * @param {string} event
     * @param {(payload:any)=>void} fn
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
     * Emit an event to all subscribers and await async listeners.
     * Supports bounded concurrency so long listener lists can be processed in
     * batches without flooding the event loop.
     * Errors thrown or rejected by listeners are swallowed.
     * @param {string} event
     * @param {any} [payload]
     * @param {Object} [options]
     * @param {number} [options.concurrency=Infinity]
     * @returns {Promise<boolean>}
     */
    emitAsync(event: string, payload?: any, { concurrency }?: {
        concurrency?: number | undefined;
    }): Promise<boolean>;
    /**
     * Return array of listeners for an event (copy).
     * @param {string} event
     * @returns {Function[]}
     */
    listeners(event: string): Function[];
    /**
     * Clear listeners for an event or all events when called without args.
     * @param {string} [event]
     */
    clear(event?: string): void;
}
export default PowerEventBus;
export type PowerEventBusOptions = {
    maxListeners?: number | undefined;
    weak?: boolean | undefined;
};
import { PowerSubscriberSet } from './powerSubscriberSet.js';
