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
  constructor(flushFn, options = {}) {
    if (typeof flushFn !== 'function') {
      throw new TypeError('PowerScheduler requires a flush function');
    }
    this._flushFn = flushFn;
    this._scheduling = options.scheduling === 'macrotask' ? 'macrotask' : 'microtask';
    this._scheduled = false;
    this._timer = null;
  }

  /** Whether a flush is currently scheduled. */
  get scheduled() {
    return this._scheduled;
  }

  /** Schedule the flush callback once. */
  schedule() {
    if (this._scheduled) return;
    this._scheduled = true;

    if (this._scheduling === 'macrotask') {
      this._timer = setTimeout(() => this._run(), 0);
      return;
    }

    queueMicrotask(() => this._run());
  }

  /** Flush immediately if a callback is scheduled. */
  flush() {
    if (!this._scheduled) return;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._run();
  }

  /** Cancel any scheduled flush without invoking the callback. */
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
      // swallow errors to avoid breaking the scheduling mechanism
      // eslint-disable-next-line no-console
      console.error(err);
    }
  }
}
