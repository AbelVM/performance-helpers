/**
 * Small scheduler helper for coalescing work into a single microtask or macrotask.
 *
 * This is useful for helpers that need to batch or debounce notifications while
 * preserving a flush API and a simple scheduling mode.
 */
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
    _timer: number | null;
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
}
