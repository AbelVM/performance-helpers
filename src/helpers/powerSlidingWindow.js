/**
 * Sliding-window rate limiter: allow up to `capacity` events per `windowMs`.
 * Uses a timestamp queue to track event occurrences.
 */
import { nowMs } from '../utils/now.js';
import { PowerQueue } from './powerQueue.js';

export class PowerSlidingWindow {
  /**
   * @param {Object} [options]
   * @param {number} [options.capacity=1] Max events allowed in window.
   * @param {number} [options.windowMs=1000] Window size in milliseconds.
   */
  /**
   * @typedef {Object} PowerSlidingWindowOptions
   * @property {number} [capacity]
   * @property {number} [windowMs]
   */
  constructor(options = {}) {
    const { capacity = 1, windowMs = 1000 } = options;
    this.capacity = Math.max(0, Number(capacity) || 0);
    this.windowMs = Math.max(1, Number(windowMs) || 1000);
    // timestamp queue (ms) backed by PowerQueue for O(1) enqueue/dequeue
    this._timestamps = new PowerQueue(16);
  }

  /**
   * Remove timestamps older than now - windowMs.
   *
   * This helper removes stale timestamps from the internal array to keep the
   * sliding window accurate. It advances the head by counting how many
   * timestamps are older than the threshold and splices them out in a single
   * operation to minimize per-call allocations.
   *
   * @private
   * @param {number} now - current timestamp in milliseconds
   * @returns {void}
   */
  _prune(now) {
    const threshold = now - this.windowMs;
    // remove from head while timestamps are older than the threshold
    while (this._timestamps.length > 0) {
      const t = this._timestamps.peek();
      if (t === undefined || t > threshold) break;
      this._timestamps.shift();
    }
  }

  /**
   * Try to consume `n` slots (default 1).
   * @param {number} [n=1]
   * @returns {boolean} True if consumption succeeded; false otherwise.
   */
  tryConsume(n = 1) {
    const want = Math.max(0, Math.floor(n) || 0);
    if (want === 0) return true;
    const now = nowMs();
    this._prune(now);
    if (this._timestamps.length + want <= this.capacity) {
      if (want === 1) this._timestamps.push(now);
      else {
        const arr = new Array(want);
        for (let i = 0; i < want; i++) arr[i] = now;
        this._timestamps.pushMany(arr);
      }
      return true;
    }
    return false;
  }

  /**
   * Return how many slots are currently available.
   * @returns {number}
   */
  available() {
    this._prune(nowMs());
    return Math.max(0, this.capacity - this._timestamps.length);
  }

  /**
   * Reset internal state.
   * @returns {void}
   */
  reset() {
    this._timestamps.clear();
  }
}
