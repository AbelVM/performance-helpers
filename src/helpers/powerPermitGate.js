/**
 * Internal permit gate helper used by semaphore-like classes.
 *
 * This helper manages a finite number of permits and a FIFO queue of waiters.
 * It is intentionally small and internal to avoid duplicating queue/release logic.
 */
import { PowerQueue } from './powerQueue.js';

/**
 * PowerPermitGate
 *
 * Internal helper that manages a finite number of permits and a FIFO waiter queue.
 * Provides `acquire()`, `tryAcquire()` and `release()` primitives used by
 * semaphore-like helpers.
 *
 * @class PowerPermitGate
 * @public
 */
export class PowerPermitGate {
  /**
   * @param {Object} [options]
   * @param {number} [options.capacity=1]
   * @param {number} [options.queueCapacity=Infinity]
   * @param {number} [options.initialTokens]
   */
  constructor(options = {}) {
    const { capacity = 1, queueCapacity = Infinity, initialTokens } = options || {};
    this._capacity = Math.max(1, Math.floor(Number(capacity) || 1));
    this._queueCapacity = Number.isFinite(Number(queueCapacity))
      ? Math.max(0, Math.floor(Number(queueCapacity)))
      : Infinity;
    this._available = Number.isFinite(initialTokens)
      ? Math.min(this._capacity, Math.max(0, Math.floor(Number(initialTokens))))
      : this._capacity;
    this._waiters = new PowerQueue(16);
  }

  /** Maximum number of permits. */
  get capacity() {
    return this._capacity;
  }

  /** Currently available permits. */
  get available() {
    return this._available;
  }

  /** Number of queued waiters. */
  get pending() {
    return this._waiters.length;
  }

  /** Maximum number of waiters allowed in the queue. */
  get queueCapacity() {
    return this._queueCapacity;
  }

  /** True when the waiting queue is saturated. */
  get isFull() {
    return this._waiters.length >= this._queueCapacity;
  }

  /** Number of permits currently held. */
  get active() {
    return this._capacity - this._available;
  }

  /**
   * Acquire a permit asynchronously.
   * Resolves immediately when a permit is available; otherwise waits in FIFO order.
   * @returns {Promise<Function>} Promise resolving to a release callback.
   */
  acquire() {
    if (this._available > 0) {
      return Promise.resolve(this._grant());
    }
    if (this.isFull) {
      return Promise.reject(new Error('PowerPermitGate queue is full'));
    }
    return new Promise((resolve, reject) => {
      this._waiters.push({ resolve, reject });
    });
  }

  /**
   * Try to acquire a permit without waiting.
   * @returns {Function|null} Release callback when acquired, otherwise `null`.
   */
  tryAcquire() {
    if (this._available > 0) {
      return this._grant();
    }
    return null;
  }

  /**
   * Release one or more permits back to the gate.
   * @param {number} [count=1]
   */
  release(count = 1) {
    let remaining = Math.max(0, Math.floor(Number(count) || 1));
    while (remaining > 0 && this._waiters.length > 0) {
      const next = this._waiters.shift();
      if (typeof next?.resolve === 'function') {
        next.resolve(this._makeRelease());
        remaining -= 1;
      }
    }
    if (remaining > 0) {
      this._available = Math.min(this._capacity, this._available + remaining);
    }
  }

  /**
   * Reset the gate and reject any waiting callers.
   * @param {Object} [options]
   * @param {number} [options.available] Number of permits to restore after reset.
   * @param {Error} [options.reason] Optional rejection reason for queued waiters.
   */
  reset(options = {}) {
    const { available = this._capacity, reason = new Error('PowerPermitGate reset') } = options;
    this._available = Math.min(this._capacity, Math.max(0, Math.floor(Number(available) || 0)));
    while (this._waiters.length > 0) {
      const next = this._waiters.shift();
      if (typeof next?.reject === 'function') next.reject(reason);
    }
  }

  _makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(1);
    };
  }

  _grant() {
    this._available -= 1;
    return this._makeRelease();
  }
}
