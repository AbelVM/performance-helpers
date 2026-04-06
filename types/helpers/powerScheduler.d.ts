/**
 * Small scheduler helper for coalescing work into a single microtask or macrotask.
 *
 * This is useful for helpers that need to batch or debounce notifications while
 * preserving a flush API and a simple scheduling mode.
 */
export class PowerScheduler {
    /**
     * @param {Function} flushFn Function called when the scheduled work is flushed.
     * @param {{scheduling?: 'microtask' | 'macrotask'}} [options]
     */
    constructor(flushFn: Function, options?: {
        scheduling?: "microtask" | "macrotask";
    });
    _flushFn: Function;
    _scheduling: string;
    _scheduled: boolean;
    _timer: number | null;
    /** Whether a flush is currently scheduled. */
    get scheduled(): boolean;
    /** Schedule the flush callback once. */
    schedule(): void;
    /** Flush immediately if a callback is scheduled. */
    flush(): void;
    /** Cancel any scheduled flush without invoking the callback. */
    cancel(): void;
    _run(): void;
}
