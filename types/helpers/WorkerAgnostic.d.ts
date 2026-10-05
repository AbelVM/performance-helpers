/**
 * Preload Node's `worker_threads` `require` for pure-ESM Node environments.
 *
 * Call this once (and `await` it) before constructing a *string-source* worker
 * in pure ESM Node, or simply set `globalThis.Worker`. It is NOT needed in
 * CJS-transpiled contexts (vitest), when passing a factory function, or when
 * `globalThis.Worker` is already present. Browser builds never need it.
 *
 * @returns {Promise<void>}
 */
export function preloadNode(): Promise<void>;
export default WorkerAgnostic;
export type WorkerLike = import("./jsdoc-types.js").WorkerLike;
export type WorkerAgnosticOptions = import("./jsdoc-types.js").WorkerAgnosticOptions;
/**
 * A CommonJS-style `require`, synthesised in pure-ESM Node.
 */
export type NodeRequire = (arg0: string) => any;
declare class WorkerAgnostic {
    /**
     * Transparently create the underlying native worker without wrapping it in a
     * `WorkerAgnostic` instance. Useful for callers (such as PowerPool) that wrap
     * the raw worker themselves but still want environment-agnostic creation.
     *
     * @param {Function|string} workerSource
     * @param {Object} [options]
     * @returns {object} The underlying worker-like object.
     */
    static create(workerSource: Function | string, options?: Object): object;
    /**
     * Create a `WorkerAgnostic` wrapping the underlying native worker for the
     * given source.
     *
     * @param {Function|string} workerSource - A Worker constructor, a worker
     *   factory function, or a path/URL string. When a function is provided it is
     *   invoked (or constructed with `new`) to obtain the underlying worker-like
     *   object. When a string is provided it is used to construct the appropriate
     *   native Worker for the current environment.
     * @param {WorkerAgnosticOptions} [options] - Options forwarded to the native
     *   Worker constructor (e.g. `{ type: 'module' }` for Node, or worker options
     *   for the browser).
     */
    constructor(workerSource: Function | string, options?: WorkerAgnosticOptions);
    env: string;
    options: {
        [x: string]: any;
    };
    /**
     * WRK-003. Where a listener throw goes.
     *
     * Read before `_wireEvents`, because a listener that throws during the initial
     * capability announcement must already have somewhere to report to.
     */
    /** @type {Array<[string, (...args: any[]) => void]>} Native listeners this instance attached,
     * as `[type, handler]`, so `dispose()` can detach exactly what it wired. */
    /** @type {Array<[string, any]>} For the property native model, the
     * `[propertyName, previousValue]` pairs to restore on disposal. */
    /** @type {boolean} */
    /** @type {import('./jsdoc-types.js').WorkerLike} */
    worker: import("./jsdoc-types.js").WorkerLike;
    /**
     * Attach the underlying worker's native events to our unified dispatcher.
     * @private
     */
    /**
     * Release every resource this instance holds.
     *
     * This wrapper owns the underlying worker and the native listeners it attached
     * to it, and both were previously unreleasable: the listeners were anonymous
     * arrow functions passed straight to `addEventListener`, so no handle existed to
     * remove them.
     *
     * **It does not terminate the worker.** `WorkerAgnostic` wraps a worker handed
     * to it by a caller, and terminating it would be a decision this class has no
     * mandate to make — `PowerPool` owns the lifecycle of its workers and drives
     * termination itself. So this detaches everything it attached and drops its own
     * listener registry; it leaves the worker alone. A caller that does own the
     * worker should terminate it, which is what the owning helper is for.
     *
     * Idempotent, and safe on an instance whose `_wireEvents` bailed early.
     *
     * @returns {void}
     */
    dispose(): void;
    /**
     * Dispatch a native event to all registered unified listeners, normalizing
     * the payload shape so consumers see a consistent `{ data }` for `message`
     * regardless of whether the runtime is Node (value delivered directly) or a
     * Web Worker (value delivered via `event.data`).
     * @private
     */
    /**
     * Fan one native worker event out to the registered listeners.
     * @param {string} type
     * @param {...*} args
     * @private
     */
    /**
     * Route a listener error to the configured `onError` handler.
     *
     * Mirrors `PowerScheduler._notifyError` deliberately rather than inventing a
     * second shape: same signature, same guard, and the same refusal to let a throwing
     * user handler escape. An error handler that throws would turn a swallowed
     * listener error into an uncaught one, which is the failure this whole mechanism
     * exists to prevent — so the guard is the point, not a detail.
     *
     * @param {any} err
     * @param {{type: string, listener: Function}} [context] - Which event and which
     *   handler threw. Included because "a listener threw" is not actionable on its
     *   own when a caller has registered several.
     * @private
     * @returns {void}
     */
    /**
     * @param {string} type
     * @param {function(...*):void} handler
     * @returns {this}
     */
    addEventListener(type: string, handler: (...args: any[]) => void): this;
    /**
     * @param {string} type
     * @param {function(...*):void} handler
     * @returns {this}
     */
    removeEventListener(type: string, handler: (...args: any[]) => void): this;
    /**
     * Node-style alias for {@link addEventListener}.
     * @param {string} type
     * @param {function(...*):void} handler
     * @returns {this}
     */
    on(type: string, handler: (...args: any[]) => void): this;
    /**
     * Node-style alias for {@link removeEventListener}.
     * @param {string} type
     * @param {function(...*):void} handler
     * @returns {this}
     */
    off(type: string, handler: (...args: any[]) => void): this;
    /**
     * @param {*} message
     * @param {ArrayBuffer[]|ArrayBufferView[]|Object} [transfer]
     * @returns {*}
     */
    postMessage(message: any, transfer?: ArrayBuffer[] | ArrayBufferView[] | Object): any;
    /**
     * @returns {Promise<void>|void}
     */
    terminate(): Promise<void> | void;
    /** @returns {void} */
    [Symbol.dispose](): void;
}
export function detectEnv(): "browser" | "webworker" | "node" | "unknown";
