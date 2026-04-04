/**
 * Sliding-window rate limiter: allow up to `capacity` events per `windowMs`.
 * Uses a timestamp queue to track event occurrences.
 */
import { nowMs } from '../utils/now.js';

export class PowerSlidingWindow {
  /**
   * @param {Object} [options]
   * @param {number} [options.capacity=1] Max events allowed in window.
   * @param {number} [options.windowMs=1000] Window size in milliseconds.
   */
  constructor(options = {}) {
    const { capacity = 1, windowMs = 1000 } = options;
    this.capacity = Math.max(0, Number(capacity) || 0);
    this.windowMs = Math.max(1, Number(windowMs) || 1000);
    // simple timestamp queue (ms)
    this._timestamps = [];
  }

  /**
   * Remove timestamps older than now - windowMs.
   * @private
   * @param {number} now - current timestamp (ms)
   */
  _prune(now) {
    const threshold = now - this.windowMs;
    let i = 0;
    while (i < this._timestamps.length && this._timestamps[i] <= threshold) i++;
    if (i > 0) this._timestamps.splice(0, i);
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
      for (let i = 0; i < want; i++) this._timestamps.push(now);
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
    this._timestamps.length = 0;
  }
}
