/**
 * Sliding-window rate limiter: allow up to `capacity` events per `windowMs`.
 * Uses a timestamp queue to track event occurrences.
 */

/**
 * @typedef {import('./jsdoc-types.js').PowerSlidingWindowOptions} PowerSlidingWindowOptions
 */
import { nowMs } from '../utils/now.js';
import { attachLimiterClock, resolveLimiterNow } from '../utils/limiterClock.js';
import { MS_PER_SEC, POWER_QUEUE_INITIAL_CAPACITY } from './constants.js';
import { PowerQueue } from './powerQueue.js';
import { assertCount, assertLimitRequired, assertKnownOptions } from '../utils/options.js';

export class PowerSlidingWindow {
  /**
   * @param {PowerSlidingWindowOptions} [options] - `capacity` defaults to 1
   *   and `windowMs` to one second.
   */
  constructor(options = {}) {
    assertKnownOptions(options, ['capacity', 'windowMs', 'now'], 'PowerSlidingWindow');
    const { capacity = 1, windowMs = MS_PER_SEC, now } = options;
    // `Math.max(0, Number(capacity) || 0)` accepted `capacity: 0`, producing a
    // window that refuses everything, and coerced NaN to 0 rather than
    // surfacing it. Both are configuration errors, so they throw.
    this.capacity = assertLimitRequired(capacity, {
      name: 'capacity',
      className: 'PowerSlidingWindow',
      min: 1,
      fallback: 1,
    });
    this.windowMs = assertLimitRequired(windowMs, {
      name: 'windowMs',
      className: 'PowerSlidingWindow',
      min: 1,
      fallback: MS_PER_SEC,
    });
    /**
     * Clock for this limiter, and whether it was explicitly injected. See
     * `resolveLimiterNow` for why the flag is load-bearing: an injected clock
     * must outrank a value threaded in by a composition.
     * @type {(() => number)}
     */
    this._now = nowMs;
    /** @type {boolean} */
    this._nowExplicit = false;
    attachLimiterClock(this, nowMs, { now }, 'PowerSlidingWindow');
    // timestamp queue (ms) backed by PowerQueue for O(1) enqueue/dequeue
    this._timestamps = new PowerQueue(POWER_QUEUE_INITIAL_CAPACITY);
  }

  /**
   * Remove timestamps older than now - windowMs.
   *
   * This helper removes stale timestamps from the internal ring-buffer queue
   * to keep the sliding window accurate. It advances the queue head one item
   * at a time using `PowerQueue.shift()`, which provides O(1) dequeue behavior
   * under sustained load.
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
    // Hand back the buffer a burst grew. The ring only ever doubles, so without
    // this a single large `tryConsume` window leaves `capacity` at its
    // high-water mark for the lifetime of the limiter — a helper whose job is
    // bounding what it remembers, keeping the memory of the worst moment it saw.
    // Called here rather than inside `shift()` so the dequeue path pays nothing:
    // this is one comparison per prune, and a prune is a window boundary rather
    // than a per-item event.
    //
    // The default floor is the queue's own initial capacity, so a limiter doing
    // steady traffic settles at that rather than reallocating on every window
    // that empties. Only a genuine drop below it reallocates.
    this._timestamps.shrink();
  }

  /**
   * Try to consume `n` slots (default 1).
   * @param {number} [n=1]
   * @param {import('../utils/limiterClock.js').LimiterNowOptions} [options] Per-call
   *   clock override.
   * @returns {boolean} True if consumption succeeded; false otherwise.
   */
  tryConsume(n = 1, options = {}) {
    const want = assertCount(n, {
      name: 'n',
      className: 'PowerSlidingWindow',
      method: 'tryConsume',
    });
    if (want === 0) return true;
    // Read once and reuse: the prune and the push must agree on the timestamp,
    // or a message is recorded at a time older than the window it was pruned
    // against and the window silently grows by one.
    const now = resolveLimiterNow(this._now, this._nowExplicit, options);
    this._prune(now);
    if (this._timestamps.length + want <= this.capacity) {
      if (want === 1) this._timestamps.push(now);
      else this._timestamps.fill(now, want);
      return true;
    }
    return false;
  }

  /**
   * Return how many slots are currently available.
   * @param {import('../utils/limiterClock.js').LimiterNowOptions} [options] Per-call
   *   clock override.
   * @returns {number}
   */
  available(options = {}) {
    this._prune(resolveLimiterNow(this._now, this._nowExplicit, options));
    return Math.max(0, this.capacity - this._timestamps.length);
  }

  /**
   * Drop every recorded timestamp, returning the window to fully available.
   * @returns {void}
   */
  reset() {
    this._timestamps.clear();
  }

  /**
   * Alias for {@link PowerSlidingWindow#reset}.
   *
   * This one is a true synonym and not a uniformity gesture: `reset()` here
   * *is* a clear - it empties the timestamp queue. Contrast the limiters, where
   * `reset()` restores a usable state (refilled tokens, re-closed circuit) and
   * `clear()` would read as the exact opposite.
   *
   * @returns {void}
   */
  clear() {
    this.reset();
  }

  /**
   * Release every resource this instance holds.
   *
   * The window holds a `PowerQueue` of timestamps and a clock reference. Neither
   * is a timer or a subscription, so this clears the recorded history and
   * re-seeds the clock rather than cancelling anything — a half-elapsed window
   * is dropped rather than left to keep admitting what it had already counted.
   *
   * Present so this helper can take part in `using` / `await using` and DI
   * teardown like every other long-lived helper in the library.
   *
   * @returns {void}
   */
  dispose() {
    // `PowerQueue` exposes `length` and `shift`; there is no `clear`, and the
    // optional-call dance that would paper over that is worse than a drain.
    while (this._timestamps.length > 0) this._timestamps.shift();
  }

  /**
   * Alias for {@link dispose}, so `using x = new PowerSlidingWindow(…)` releases
   * it deterministically at scope exit.
   *
   * @returns {void}
   */
  [Symbol.dispose]() {
    this.dispose();
  }
}
