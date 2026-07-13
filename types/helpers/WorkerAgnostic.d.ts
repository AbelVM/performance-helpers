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
     * @param {Object} [options] - Options forwarded to the native Worker
     *   constructor (e.g. `{ type: 'module' }` for Node, or worker options for
     *   the browser).
     */
    constructor(workerSource: Function | string, options?: Object);
    env: string;
    options: Object;
    _listeners: Map<any, any>;
    worker: object;
    /**
     * Attach the underlying worker's native events to our unified dispatcher.
     * @private
     */
    private _wireEvents;
    _nativeModel: string | undefined;
    /**
     * Dispatch a native event to all registered unified listeners, normalizing
     * the payload shape so consumers see a consistent `{ data }` for `message`
     * regardless of whether the runtime is Node (value delivered directly) or a
     * Web Worker (value delivered via `event.data`).
     * @private
     */
    private _dispatch;
    addEventListener(type: any, handler: any): this;
    removeEventListener(type: any, handler: any): this;
    on(type: any, handler: any): this;
    off(type: any, handler: any): this;
    postMessage(message: any, transfer: any): any;
    terminate(): any;
}
export function detectEnv(): "browser" | "webworker" | "node" | "unknown";
