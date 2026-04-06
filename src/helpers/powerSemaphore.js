/**
 * Lightweight async concurrency gate for IO-heavy fanout.
 *
 * Use `PowerSemaphore` to limit concurrent async work without blocking the
 * event loop.
 *
 * @example
 * const gate = new PowerSemaphore(3);
 * const release = await gate.acquire();
 * try {
 *   await doWork();
 * } finally {
 *   release();
 * }
 */
export class PowerSemaphore {
  /**
   * Create a semaphore.
   * @param {number} [limit=1] Maximum number of concurrent permits.
   */
  constructor(limit = 1) {
    this._limit = Math.max(1, Math.floor(Number(limit) || 1));
    this._active = 0;
    /** @type {Array<(release:Function)=>void>} */
    this._queue = [];
  }

  /** Maximum concurrent holders. */
  get limit() {
    return this._limit;
  }

  /** Currently acquired permits. */
  get active() {
    return this._active;
  }

  /** Number of callers waiting for a permit. */
  get pending() {
    return this._queue.length;
  }

  /** Number of permits still available. */
  get available() {
    return this._limit - this._active;
  }

  /** True when the semaphore is fully acquired. */
  get isLocked() {
    return this._active >= this._limit;
  }

  /**
   * Acquire a permit asynchronously.
   * Resolves immediately when one is available; otherwise waits in FIFO order.
   * @returns {Promise<Function>} Promise resolving to the release callback.
   */
  acquire() {
    if (this._active < this._limit) return Promise.resolve(this._grant());
    return new Promise((resolve) => {
      this._queue.push(resolve);
    });
  }

  /**
   * Try to acquire a permit without waiting.
   * @returns {Function|null} Release callback when acquired, otherwise `null`.
   */
  tryAcquire() {
    if (this._active < this._limit) return this._grant();
    return null;
  }

  /**
   * Execute a callback while holding a permit.
   * The permit is released after the callback resolves or rejects.
   * @template T
   * @param {() => Promise<T> | T} fn Callback to run under a permit.
   * @returns {Promise<T>} The callback result.
   */
  async run(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Internal helper that increments active permits and returns a release callback.
   * @returns {Function} Release callback.
   * @private
   */
  _grant() {
    this._active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this._queue.length > 0) {
        const next = this._queue.shift();
        next(this._grant());
      } else {
        this._active -= 1;
      }
    };
  }
}

export default PowerSemaphore;
