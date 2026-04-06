/**
 * Producer-facing backpressure controller with adaptive refill.
 *
 * Use `PowerBackpressure` to gate producer throughput while allowing
 * consumers to release capacity and the helper to refill adaptively when
 * pressure is high.
 */
import { PowerQueue } from './powerQueue.js';

export class PowerBackpressure {
  /**
   * @param {Object} [options]
   * @param {number} [options.capacity=100] Maximum number of concurrent permits.
   * @param {number} [options.queueCapacity=1000] Maximum number of waiting producers.
   * @param {number} [options.lowWaterMark=Math.ceil(capacity * 0.25)] When available tokens drop below this threshold, adaptive refill begins.
   * @param {number} [options.refillAmount=Math.max(1, Math.ceil(capacity * 0.1))] Base refill amount when pressure is detected.
   * @param {number} [options.refillInterval=200] Refill interval in milliseconds.
   * @param {number} [options.initialTokens=capacity] Initial available permits.
   */
  constructor(options = {}) {
    const {
      capacity = 100,
      queueCapacity = 1000,
      lowWaterMark = null,
      refillAmount = null,
      refillInterval = 200,
      initialTokens = undefined,
    } = options || {};

    this._capacity = Math.max(1, Math.floor(Number(capacity) || 100));
    this._queueCapacity = Math.max(0, Math.floor(Number(queueCapacity) || 1000));
    this._lowWaterMark = Number.isFinite(lowWaterMark)
      ? Math.min(Math.max(1, Math.floor(lowWaterMark)), this._capacity - 1)
      : Math.max(1, Math.ceil(this._capacity * 0.25));
    this._refillAmount = Number.isFinite(refillAmount)
      ? Math.max(1, Math.min(Math.floor(refillAmount), this._capacity))
      : Math.max(1, Math.ceil(this._capacity * 0.1));
    this._refillInterval = Math.max(1, Math.floor(Number(refillInterval) || 200));
    this._available = Number.isFinite(initialTokens)
      ? Math.min(this._capacity, Math.max(0, Math.floor(initialTokens)))
      : this._capacity;

    this._waiters = new PowerQueue();
    this._refillTimer = null;
  }

  /** Maximum concurrent permits. */
  get capacity() {
    return this._capacity;
  }

  /** Available permits for producers. */
  get available() {
    return this._available;
  }

  /** Number of producers currently waiting for permits. */
  get pending() {
    return this._waiters.length;
  }

  /** Maximum number of waiting producers. */
  get queueCapacity() {
    return this._queueCapacity;
  }

  /** True when the waiting queue is full. */
  get isFull() {
    return this._waiters.length >= this._queueCapacity;
  }

  /**
   * Acquire a permit asynchronously.
   * Resolves immediately when a permit is available.
   * Otherwise queues the producer until capacity frees.
   * @returns {Promise<Function>} Promise resolving to a release callback.
   */
  acquire() {
    if (this._available > 0) {
      return Promise.resolve(this._grant());
    }

    if (this._waiters.length >= this._queueCapacity) {
      return Promise.reject(new Error('PowerBackpressure queue is full'));
    }

    return new Promise((resolve, reject) => {
      this._waiters.push({ resolve, reject });
      if (!this._refillTimer) {
        this._scheduleRefill();
      }
    });
  }

  /**
   * Try to acquire a permit immediately.
   * @returns {Function|null} Release callback, or `null` if no permit is available.
   */
  tryAcquire() {
    if (this._available > 0) {
      return this._grant();
    }
    return null;
  }

  /**
   * Release one or more permits back to the controller.
   * @param {number} [count=1]
   */
  release(count = 1) {
    let remaining = Math.max(0, Math.floor(Number(count) || 1));
    while (remaining > 0 && this._waiters.length > 0) {
      const next = this._waiters.shift();
      if (next && typeof next.resolve === 'function') {
        next.resolve(this._grant());
        remaining -= 1;
      }
    }

    if (remaining > 0) {
      this._available = Math.min(this._capacity, this._available + remaining);
    }

    if (this._available < this._lowWaterMark && this._waiters.length > 0) {
      this._scheduleRefill();
    }
  }

  /**
   * Reset the controller to its initial capacity and clear waiting producers.
   */
  reset() {
    this._available = this._capacity;
    while (this._waiters.length > 0) {
      const next = this._waiters.shift();
      if (next && typeof next.reject === 'function') {
        next.reject(new Error('PowerBackpressure reset'));
      }
    }
    if (this._refillTimer) {
      clearTimeout(this._refillTimer);
      this._refillTimer = null;
    }
  }

  _grant() {
    this._available -= 1;
    let released = false;

    return () => {
      if (released) return;
      released = true;
      this.release(1);
    };
  }

  _scheduleRefill() {
    if (this._refillTimer || this._waiters.length === 0) return;
    this._refillTimer = setTimeout(() => {
      this._refillTimer = null;
      this._performRefill();
    }, this._refillInterval);
  }

  _performRefill() {
    if (this._waiters.length === 0) return;
    const missing = this._capacity - this._available;
    if (missing <= 0) return;

    const adaptiveAmount = Math.min(
      this._capacity,
      this._refillAmount + Math.ceil(this._waiters.length / 10)
    );
    const refill = Math.min(adaptiveAmount, missing);
    this._available += refill;

    while (this._available > 0 && this._waiters.length > 0) {
      const next = this._waiters.shift();
      if (next && typeof next.resolve === 'function') {
        this._available -= 1;
        next.resolve(this._grant());
      }
    }

    if (this._available < this._lowWaterMark && this._waiters.length > 0) {
      this._scheduleRefill();
    }
  }
}

export default PowerBackpressure;
