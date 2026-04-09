/**
 * PowerScheduler
 *
 * Small scheduler helper for coalescing work into a single microtask or macrotask.
 * Useful for batching or debouncing flushes while providing `schedule()`,
 * `flush()` and `cancel()` controls.
 *
 * @class PowerScheduler
 * @public
 */
export class PowerScheduler {
  /**
   * @param {Function} flushFn Function called when the scheduled work is flushed.
   * @param {{scheduling?: 'microtask' | 'macrotask', onError?: ((error: unknown) => void) | null}} [options]
   * Scheduling and error handling options.
   */
  constructor(flushFn, options = {}) {
    if (typeof flushFn !== 'function') {
      throw new TypeError('PowerScheduler requires a flush function');
    }
    this._flushFn = flushFn;
    this._scheduling = options.scheduling === 'macrotask' ? 'macrotask' : 'microtask';
    this._onError = typeof options.onError === 'function' ? options.onError : null;
    this._scheduled = false;
    this._timer = null;
  }

  /** Whether a flush is currently scheduled. */
  get scheduled() {
    return this._scheduled;
  }

  /**
   * Schedule the flush callback once.
   * @returns {void}
   */
  schedule() {
    if (this._scheduled) return;
    this._scheduled = true;

    if (this._scheduling === 'macrotask') {
      this._timer = setTimeout(() => this._run(), 0);
      return;
    }

    queueMicrotask(() => this._run());
  }

  /**
   * Flush immediately if a callback is scheduled.
   * @returns {void}
   */
  flush() {
    if (!this._scheduled) return;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._run();
  }

  /**
   * Cancel any scheduled flush without invoking the callback.
   * @returns {void}
   */
  cancel() {
    if (!this._scheduled) return;
    this._scheduled = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _run() {
    if (!this._scheduled) return;
    this._scheduled = false;
    this._timer = null;
    try {
      this._flushFn();
    } catch (err) {
      // Swallow flush errors to keep scheduler mechanics intact.
      if (!this._onError) return;
      try {
        this._onError(err);
      } catch {
        // ignore logger failures
      }
    }
  }
}
