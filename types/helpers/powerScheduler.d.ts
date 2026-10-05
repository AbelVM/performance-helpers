export class PowerScheduler {
    /**
     * @param {Function} flushFn Function called when the scheduled work is flushed.
     * @param {PowerSchedulerOptions} [options] Scheduling and error handling options.
     */
    constructor(flushFn: Function, options?: PowerSchedulerOptions);
    _flushFn: Function;
    /** @type {'microtask'|'macrotask'|'yield'|'postTask'} */
    _scheduling: "microtask" | "macrotask" | "yield" | "postTask";
    _taskPriority: "user-blocking" | "user-visible" | "background";
    _onError: ((error: unknown) => void) | null;
    _scheduled: boolean;
    /** @type {?MacrotaskHandle} */
    _timer: MacrotaskHandle | null;
    /** @type {?TaskController} The live `postTask` controller, if any. GAP-013. */
    _taskController: TaskController | null;
    _generation: number;
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
     * @returns {{scheduling: 'microtask'|'macrotask'|'yield'|'postTask', supported: boolean}}
     */
    get strategy(): {
        scheduling: "microtask" | "macrotask" | "yield" | "postTask";
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
    /**
     * Abort a pending `scheduler.postTask`, if one is outstanding.
     *
     * **Separate from `cancel()` because the two are not the same operation.** `cancel()`
     * is *this scheduler's* business — drop my pending flush — and it runs on every
     * strategy. This is the platform's: stop a task that may already be queued with the
     * browser's scheduler, which is a queue this library does not own and cannot drain.
     *
     * Reached from `flush()` and `cancel()`, and from `dispose()` *through* `cancel()` —
     * there is no third call site, which is the part worth knowing: a reader auditing this
     * will find two calls in the file and may reasonably conclude teardown misses it.
     * Verified that it does not. A `postTask` flush left un-aborted by `dispose()` lands
     * after teardown and runs a callback against a disposed scheduler.
     *
     * Idempotent by field rather than by the platform's tolerance: `_taskController` is
     * nulled *before* `abort()` and again by the task callback when it runs, so a repeat
     * call returns on the guard and the platform never sees a second `abort()`.
     *
     * @private
     * @returns {void}
     */
    private _abortTask;
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
