export class PowerScheduler {
    /**
     * @param {Function} flushFn Function called when the scheduled work is flushed.
     * @param {{scheduling?: 'microtask' | 'macrotask', onError?: ((error: unknown) => void) | null}} [options]
     * Scheduling and error handling options.
     */
    constructor(flushFn: Function, options?: {
        scheduling?: "microtask" | "macrotask";
        onError?: ((error: unknown) => void) | null;
    });
    _flushFn: Function;
    _scheduling: string;
    _onError: ((error: unknown) => void) | null;
    _scheduled: boolean;
    _timer: MacrotaskHandle | null;
    /** Whether a flush is currently scheduled. */
    get scheduled(): boolean;
    /**
     * Schedule the flush callback once.
     * @returns {void}
     */
    schedule(): void;
    /**
     * Flush immediately if a callback is scheduled.
     * @returns {void}
     */
    flush(): void;
    /**
     * Cancel any scheduled flush without invoking the callback.
     * @returns {void}
     */
    cancel(): void;
    _run(): void;
    /**
     * Route an error to the configured `onError` handler without ever letting a
     * throwing user handler escape.
     * @param {any} err
     * @private
     * @returns {void}
     */
    private _notifyError;
    /**
     * Release every resource this instance holds.
     *
     * Idempotent, and safe to call while the instance is idle. Exists so the
     * instance works with `using` / `await using` and gives callers an explicit
     * name to call.
     *
     * @returns {void}
     */
    dispose(): void;
    /**
     * Alias for {@link dispose}, so `using x = new X()` releases the instance
     * deterministically at scope exit.
     * @returns {void}
     */
    [Symbol.dispose](): void;
}
export type MacrotaskHandle = {
    cancel: () => void;
};
