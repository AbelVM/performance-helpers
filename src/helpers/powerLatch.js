/**
 * PowerLatch — a simple counting barrier.
 * Resolves waiters when the internal count reaches zero.
 *
 * @example
 * const latch = new PowerLatch(3);
 * // from three independent async paths:
 * latch.countDown();
 * latch.countDown();
 * latch.countDown();
 * await latch.wait(); // resolves when count reaches 0
 */
import { PowerDefer } from './powerDefer.js';

export class PowerLatch {
  /**
   * @typedef {Object} PowerLatchOptions
   * @property {(reason:any)=>void} [onAbort]
   */
  /**
   * @param {number} [count=1] - initial count required to release the latch
   */
  constructor(count = 1, options = {}) {
    this._count = Math.max(0, Number(count) || 0);
    /** @type {Array<{defer:PowerDefer, timer?:any, signalHandler?:Function, signal?:AbortSignal}>} */
    this._waiters = [];
    this._aborted = false;
    this._abortReason = null;
    this._onAbort = typeof options.onAbort === 'function' ? options.onAbort : null;
  }

  /**
   * Optional callback invoked when `abort()` is called: `(reason) => void`.
   */
  get onAbort() {
    return this._onAbort;
  }

  set onAbort(fn) {
    this._onAbort = typeof fn === 'function' ? fn : null;
  }

  /**
   * Decrement the latch by one (or by `n` if provided). When the count
   * reaches zero all pending waiters are resolved.
   * @param {number} [n=1]
   * @returns {number} remaining count
   */
  countDown(n = 1) {
    const dec = Math.max(0, Math.floor(Number(n) || 0));
    if (dec === 0) return this._count;
    this._count = Math.max(0, this._count - dec);
    if (this._count === 0) this._resolveAll();
    return this._count;
  }

  /**
   * Decrement the latch only if it's greater than zero.
   * Returns remaining count.
   * @returns {number}
   */
  decrementUnlessZero() {
    if (this._count === 0) return 0;
    return this.countDown(1);
  }

  /**
   * Wait until the latch reaches zero. If already zero returns a resolved Promise.
   * @returns {Promise<void>}
   */
  /**
   * Wait until the latch reaches zero.
   * Options: `wait(timeoutMs)` or `wait({ timeout, signal })`.
   * If aborted via `abort()` pending waiters are rejected.
   * @param {number|object} [opts]
   * @returns {Promise<void>}
   */
  wait(opts) {
    if (this._aborted)
      return Promise.reject(
        this._abortReason || Object.assign(new Error('Aborted'), { code: 'EABORT' })
      );
    if (this._count === 0) return Promise.resolve();

    let timeout = null;
    let signal = null;
    if (typeof opts === 'number') timeout = opts;
    else if (opts && typeof opts === 'object') {
      timeout = opts.timeout || null;
      signal = opts.signal || null;
    }

    const defer = new PowerDefer();
    const waiter = { defer, timer: null, signalHandler: null, signal };

    // register timeout
    if (typeof timeout === 'number' && timeout > 0) {
      waiter.timer = setTimeout(() => {
        this._removeWaiter(waiter);
        defer.reject(Object.assign(new Error('Timeout'), { code: 'ETIMEOUT' }));
      }, timeout);
    }

    // register abort signal
    if (signal && typeof signal.addEventListener === 'function') {
      const onAbort = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        this._removeWaiter(waiter);
        defer.reject(signal.reason || Object.assign(new Error('Aborted'), { code: 'EABORT' }));
      };
      waiter.signalHandler = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
    }

    this._waiters.push(waiter);
    return defer.promise;
  }

  /**
   * Reset the latch to a new count. Any existing waiters will be resolved
   * immediately if the new count is zero.
   * @param {number} [count=1]
   */
  reset(count = 1) {
    this._count = Math.max(0, Number(count) || 0);
    if (this._count === 0) this._resolveAll();
    // resetting clears aborted state
    this._aborted = false;
    this._abortReason = null;
  }

  /**
   * Number of remaining counts.
   * @returns {number}
   */
  get remaining() {
    return this._count;
  }

  /**
   * True when the latch is already released.
   * @returns {boolean}
   */
  get done() {
    return this._count === 0;
  }

  _removeWaiter(waiter) {
    const idx = this._waiters.indexOf(waiter);
    if (idx !== -1) this._waiters.splice(idx, 1);
    if (
      waiter.signalHandler &&
      waiter.signal &&
      typeof waiter.signal.removeEventListener === 'function'
    ) {
      try {
        waiter.signal.removeEventListener('abort', waiter.signalHandler);
      } catch (e) {
        /* swallow */
      }
    }
    return waiter;
  }

  _resolveAll() {
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) {
      try {
        if (w.timer) clearTimeout(w.timer);
        if (w.signalHandler && w.signal && typeof w.signal.removeEventListener === 'function') {
          try {
            w.signal.removeEventListener('abort', w.signalHandler);
          } catch (e) {
            /* swallow */
          }
        }
        w.defer.resolve();
      } catch (e) {
        /* swallow */
      }
    }
  }

  _rejectAll(err) {
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) {
      try {
        if (w.timer) clearTimeout(w.timer);
        if (w.signalHandler && w.signal && typeof w.signal.removeEventListener === 'function') {
          try {
            w.signal.removeEventListener('abort', w.signalHandler);
          } catch (e) {
            /* swallow */
          }
        }
        w.defer.reject(err);
      } catch (e) {
        /* swallow */
      }
    }
  }

  /**
   * Abort pending waiters. If `reason` provided it will be used to reject waiters.
   * @param {any} [reason]
   */
  abort(reason) {
    this._aborted = true;
    this._abortReason = reason || Object.assign(new Error('Aborted'), { code: 'EABORT' });
    // invoke optional onAbort callback
    try {
      if (typeof this._onAbort === 'function') this._onAbort(this._abortReason);
    } catch (e) {
      // swallow
    }
    this._rejectAll(this._abortReason);
  }

  /**
   * Create a latch that waits for a single signal.
   * @returns {PowerLatch}
   */
  static one() {
    return new PowerLatch(1);
  }
}

export default PowerLatch;
