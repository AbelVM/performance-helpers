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
/**
 * @typedef {import('./jsdoc-types.js').PowerReleaseFn} PowerReleaseFn
 */
import { PowerPermitGate } from './powerPermitGate.js';
import { assertKnownOptions } from '../utils/options.js';

export class PowerSemaphore {
  /**
   * Create a semaphore.
   * @param {number} [limit=1] Maximum number of concurrent permits.
   */
  constructor(limit = 1) {
    // An options object as the sole argument means the caller reached for the
    // obvious shape, and it used to be rejected outright with a message naming a
    // number they had just passed an object for. `PowerTTLMap` already normalises
    // both forms; so now do these.
    // An options object is recognised only when it carries at least one known
    // option key. A bare `{}` still falls through to the numeric path and is
    // rejected as before — which `test/powerLatch.reset.test.js` pins as a
    // property: whatever the constructor rejects, `reset()` must reject too.
    if (limit && typeof limit === 'object' && 'limit' in limit) {
      // Validate the object rather than reading one key out of it — otherwise
      // `{ limit: 3, nonsense: 1 }` would pass, and arriving in the
      // options-object form would be a way to *bypass* 8f83c07 rather than a
      // second way to satisfy it.
      const opts = /** @type {{limit?: number}} */ (limit);
      assertKnownOptions(opts, ['limit'], 'PowerSemaphore');
      limit = opts.limit;
    }
    // The gate reports validation failures with the class name and option name
    // it was built with, so pass this class's own vocabulary: a caller who
    // wrote `new PowerSemaphore(0)` has to be told about `PowerSemaphore` and
    // `limit`. Without this every error said "PowerPermitGate: `capacity`",
    // naming an internal building block and an option that does not exist on
    // this class — which is what `assertLimitRequired`'s `className` exists to
    // prevent.
    this._gate = new PowerPermitGate({
      capacity: limit,
      initialTokens: limit,
      className: 'PowerSemaphore',
      limitName: 'limit',
    });
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
   * @param {{signal?: AbortSignal}} [options] - Pass `options.signal` to stop
   *   waiting: the returned promise rejects with an `AbortError` and the caller
   *   leaves the queue instead of holding a slot until a permit arrives.
   * @returns {Promise<function():void>} Promise resolving to the release
   *   callback. Spelled as a call signature rather than `Function` because
   *   `Function` is not assignable to `() => void`, so `.then((release) =>
   *   release())` - the documented way to use it - failed to type-check for
   *   consumers.
   */
  acquire(options = {}) {
    return this._gate.acquire(options);
  }

  /**
   * Try to acquire a permit without waiting.
   * @returns {PowerReleaseFn|null} Release callback when acquired, otherwise `null`.
   */
  tryAcquire() {
    return this._gate.tryAcquire();
  }

  /**
   * Execute a callback while holding a permit.
   * The permit is released after the callback resolves or rejects.
   *
   * `options` is forwarded to {@link acquire}, so `{ signal }` cancels the
   * *wait* for a permit. It used to be accepted and thrown away — this method
   * took only `fn` — so a caller who mirrored `acquire()` got a promise that
   * could not be cancelled and, with an already-aborted signal, hung until a
   * permit happened to be released. `run` is the form people reach for first,
   * so cancellation matters more here than on `acquire`.
   *
   * @template T
   * @param {() => Promise<T> | T} fn Callback to run under a permit.
   * @param {{signal?: AbortSignal}} [options] Forwarded to {@link acquire}.
   * @returns {Promise<T>} The callback result.
   */
  async run(fn, options = {}) {
    const release = await this.acquire(options);
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
