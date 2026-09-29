export class PowerScheduler {
    /**
     * @param {Function} flushFn Function called when the scheduled work is flushed.
     * @param {PowerSchedulerOptions} [options] Scheduling and error handling options.
     */
    constructor(flushFn: Function, options?: PowerSchedulerOptions);
    _flushFn: Function;
    /** @type {'microtask'|'macrotask'|'yield'} */
    _scheduling: "microtask" | "macrotask" | "yield";
    _onError: ((error: unknown) => void) | null;
    _scheduled: boolean;
    _timer: MacrotaskHandle | {
        cancel: () => void;
    } | null;
    /** Whether a flush is currently scheduled. */
    get scheduled(): boolean;
    /**
     * The strategy this scheduler was *configured* with, and whether the runtime
     * can actually honour it.
     *
     * Both halves, because they can differ: `scheduling: 'yield'` falls back to a
     * macrotask where `scheduler.yield()` does not exist, and without this a
     * caller has no way to know it is running on the fallback. The fallback is a
     * degradation in *ordering*, not correctness — the flush still happens
     * promptly — which is exactly why it should be visible rather than silent.
     *
     * @returns {{scheduling: 'microtask'|'macrotask'|'yield', supported: boolean}}
     */
    get strategy(): {
        scheduling: "microtask" | "macrotask" | "yield";
        supported: boolean;
    };
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
export type PowerSchedulerOptions = import("./jsdoc-types.js").PowerSchedulerOptions;
