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
import { PowerPermitGate } from './powerPermitGate.js';

export class PowerSemaphore {
  /**
   * Create a semaphore.
   * @param {number} [limit=1] Maximum number of concurrent permits.
   */
  constructor(limit = 1) {
    this._gate = new PowerPermitGate({ capacity: limit, initialTokens: limit });
  }

  /** Maximum concurrent holders. */
  get limit() {
    return this._gate.capacity;
  }

  /** Currently acquired permits. */
  get active() {
    return this._gate.active;
  }

  /** Number of callers waiting for a permit. */
  get pending() {
    return this._gate.pending;
  }

  /** Number of permits still available. */
  get available() {
    return this._gate.available;
  }

  /** True when the semaphore is fully acquired. */
  get isLocked() {
    return this._gate.available === 0;
  }

  /**
   * Acquire a permit asynchronously.
   * Resolves immediately when one is available; otherwise waits in FIFO order.
   * @returns {Promise<function():void>} Promise resolving to the release
   *   callback. Spelled as a call signature rather than `Function` because
   *   `Function` is not assignable to `() => void`, so `.then((release) =>
   *   release())` - the documented way to use it - failed to type-check for
   *   consumers.
   */
  acquire() {
    return this._gate.acquire();
  }

  /**
   * Try to acquire a permit without waiting.
   * @returns {Function|null} Release callback when acquired, otherwise `null`.
   */
  tryAcquire() {
    return this._gate.tryAcquire();
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
   * Reset the semaphore and reject any queued waiters.
   * @returns {void}
   */
  reset() {
    this._gate.reset({ available: this._gate.capacity });
  }

  /**
   * Release every resource this instance holds.
   *
   * Idempotent, and safe to call while the instance is idle. Exists so the
   * instance works with `using` / `await using` and gives callers an explicit
   * name to call.
   *
   * @returns {void}
   */
  dispose() {
    this.reset();
    // Neutralise the cleanup so a second dispose (or a late call) is a no-op
    // rather than a second teardown pass.
    this.reset = () => {};
  }

  /**
   * Alias for {@link dispose}, so `using x = new X()` releases the instance
   * deterministically at scope exit.
   * @returns {void}
   */
  [Symbol.dispose]() {
    this.dispose();
  }
}

export default PowerSemaphore;
