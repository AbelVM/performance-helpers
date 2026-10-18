/**
 * @typedef {Object} PowerTaskGroupOptions
 * @property {boolean} [cancelOnError=true] - Abort siblings when a task rejects.
 */
export class PowerTaskGroup {
    /**
     * @param {PowerTaskGroupOptions} [options]
     */
    constructor(options?: PowerTaskGroupOptions);
    /** The scope's abort signal, shared by every task. */
    get signal(): AbortSignal;
    /** Whether the scope has been disposed. */
    get disposed(): boolean;
    /** Number of tasks currently in flight. */
    get size(): number;
    /**
     * Run an async task inside the scope. The task receives the scope's
     * `AbortSignal` and may return a value. The returned promise resolves with
     * the task's result or rejects with its error (or an `AbortError` if the
     * scope was cancelled).
     *
     * @param {(signal: AbortSignal) => any} fn
     * @returns {Promise<any>}
     */
    run(fn: (signal: AbortSignal) => any): Promise<any>;
    /**
     * Spawn a task without awaiting it. Returns the promise for callers that
     * want to observe it; errors are still routed through `cancelOnError`.
     * @param {(signal: AbortSignal) => any} fn
     * @returns {Promise<any>}
     */
    spawn(fn: (signal: AbortSignal) => any): Promise<any>;
    /**
     * Wait for all in-flight tasks to settle.
     * @returns {Promise<any[]>}
     */
    all(): Promise<any[]>;
    /**
     * Abort every in-flight task and wait for them to settle.
     * @returns {Promise<void>}
     */
    cancel(): Promise<void>;
    /**
     * Dispose the scope: abort all tasks and wait for them to settle.
     * @returns {Promise<void>}
     */
    dispose(): Promise<void>;
    /**
     * Synchronous disposal: aborts all tasks but does not await them.
     * @returns {void}
     */
    [Symbol.dispose](): void;
    /**
     * Asynchronous disposal: aborts and awaits all tasks.
     * @returns {Promise<void>}
     */
    [Symbol.asyncDispose](): Promise<void>;
}
export default PowerTaskGroup;
export type PowerTaskGroupOptions = {
    /**
     * - Abort siblings when a task rejects.
     */
    cancelOnError?: boolean | undefined;
};
