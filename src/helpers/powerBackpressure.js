/**
 * Producer-facing backpressure controller with adaptive refill.
 *
 * Use `PowerBackpressure` to gate producer throughput while allowing
 * consumers to release capacity and the helper to refill adaptively when
 * pressure is high.
 */
import { PowerPermitGate } from './powerPermitGate.js';
import {
  DEFAULT_QUEUE_CAPACITY,
  DEFAULT_BACKPRESSURE_QUEUE_CAPACITY,
  DEFAULT_BACKPRESSURE_REFILL_INTERVAL_MS,
} from './constants.js';

/**
 * PowerBackpressure
 *
 * Producer-facing backpressure controller built on top of `PowerPermitGate`.
 * Provides adaptive refill behavior and FIFO queuing for producers.
 *
 * @class PowerBackpressure
 * @public
 */
export class PowerBackpressure extends PowerPermitGate {
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
      capacity = DEFAULT_QUEUE_CAPACITY,
      queueCapacity = DEFAULT_BACKPRESSURE_QUEUE_CAPACITY,
      lowWaterMark = null,
      refillAmount = null,
      refillInterval = DEFAULT_BACKPRESSURE_REFILL_INTERVAL_MS,
      initialTokens = undefined,
    } = options || {};

    const normalizedCapacity = Math.max(1, Math.floor(Number(capacity) || DEFAULT_QUEUE_CAPACITY));
    const normalizedLowWaterMark = Number.isFinite(lowWaterMark)
      ? Math.min(Math.max(1, Math.floor(lowWaterMark)), normalizedCapacity - 1)
      : Math.max(1, Math.ceil(normalizedCapacity * 0.25));
    const normalizedRefillAmount = Number.isFinite(refillAmount)
      ? Math.max(1, Math.min(Math.floor(refillAmount), normalizedCapacity))
      : Math.max(1, Math.ceil(normalizedCapacity * 0.1));
    const normalizedRefillInterval = Math.max(
      1,
      Math.floor(Number(refillInterval) || DEFAULT_BACKPRESSURE_REFILL_INTERVAL_MS)
    );

    super({
      capacity: normalizedCapacity,
      queueCapacity,
      initialTokens,
    });

    this._capacity = normalizedCapacity;
    this._lowWaterMark = normalizedLowWaterMark;
    this._refillAmount = normalizedRefillAmount;
    this._refillInterval = normalizedRefillInterval;
    this._refillTimer = null;
  }

  /** Maximum concurrent permits. */
  get capacity() {
    return this._capacity;
  }

  /** Available permits for producers. */
  get available() {
    return super.available;
  }

  /** Number of producers currently waiting for permits. */
  get pending() {
    return super.pending;
  }

  /** Maximum number of waiting producers. */
  get queueCapacity() {
    return super.queueCapacity;
  }

  /** True when the waiting queue is full. */
  get isFull() {
    return super.isFull;
  }

  /**
   * Acquire a permit asynchronously.
   * Resolves immediately when a permit is available.
   * Otherwise queues the producer until capacity frees.
   * @returns {Promise<Function>} Promise resolving to a release callback.
   */
  acquire() {
    if (this.available > 0) {
      return Promise.resolve(this._grant());
    }
    if (this.isFull) {
      return Promise.reject(new Error('PowerBackpressure queue is full'));
    }
    const promise = super.acquire();
    if (this.pending > 0 && !this._refillTimer) {
      this._scheduleRefill();
    }
    return promise;
  }

  /**
   * Try to acquire a permit immediately.
   * @returns {Function|null} Release callback, or `null` if no permit is available.
   */
  tryAcquire() {
    return super.tryAcquire();
  }

  /**
   * Release one or more permits back to the controller.
   * @param {number} [count=1]
   */
  release(count = 1) {
    super.release(count);
    if (this.available < this._lowWaterMark && this.pending > 0) {
      this._scheduleRefill();
    }
  }

  /**
   * Reset the controller to its initial capacity and clear waiting producers.
   */
  reset() {
    super.reset({ available: this._capacity, reason: new Error('PowerBackpressure reset') });
    if (this._refillTimer) {
      clearTimeout(this._refillTimer);
      this._refillTimer = null;
    }
  }

  _grant() {
    return super._grant();
  }

  _scheduleRefill() {
    if (this._refillTimer || this.pending === 0) return;
    this._refillTimer = setTimeout(() => {
      this._refillTimer = null;
      this._performRefill();
    }, this._refillInterval);
  }

  _performRefill() {
    if (this.pending === 0) return;
    const missing = this._capacity - this._available;
    if (missing <= 0) return;

    const adaptiveAmount = Math.min(
      this._capacity,
      this._refillAmount + Math.ceil(this.pending / 10)
    );
    const refill = Math.min(adaptiveAmount, missing);
    this._available += refill;

    while (this._available > 0 && this.pending > 0) {
      const next = this._waiters.shift();
      if (typeof next?.resolve === 'function') {
        this._available -= 1;
        next.resolve(this._makeRelease());
      }
    }

    if (this._available < this._lowWaterMark && this.pending > 0) {
      this._scheduleRefill();
    }
  }
}

export default PowerBackpressure;
