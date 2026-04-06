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
    /** @type {Map<string, Set<any>>} */
    _listeners: Map<string, Set<any>>;
    _liveCounts: Map<any, any>;
    _maxListeners: number;
    _weak: boolean;
    _fr: any;
    _onceMap: WeakMap<object, any> | undefined;
    /**
     * Cleanup dead weak refs from internal listener sets.
     * Useful in tests or environments where FinalizationRegistry/GC is unavailable.
     */
    cleanup(): void;
    /**
     * Subscribe to an event.
     * @param {string} event
     * @param {(payload:any)=>void} fn
     * @returns {() => void} unsubscribe
     */
    on(event: string, fn: (payload: any) => void): () => void;
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
