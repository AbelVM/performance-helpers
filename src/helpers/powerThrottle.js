/**
 * Token-bucket rate limiter.
 * Controls the rate of events by allowing up to `capacity` tokens and
 * refilling at a configured `refillRate`.
 *
 * Options:
 * - `capacity` (number): maximum tokens in the bucket (default 1)
 * - `tokens` (number): initial tokens (default = capacity)
 * - `refillRate` (number): tokens per second to add (default 0)
 * - `refillInterval` (number): ms interval used for bookkeeping (default 1000)
 *
 * @class PowerThrottle
 * @public
 */
/**
 * @typedef {import('./jsdoc-types.js').PowerThrottleOptions} PowerThrottleOptions
 */
import { nowMs } from '../utils/now.js';
import { DEFAULT_REFILL_INTERVAL_MS, MS_PER_SEC } from './constants.js';

export class PowerThrottle {
  /**
   * @param {Object} [options]
   * @param {number} [options.capacity=1]
   * @param {number} [options.tokens]
   * @param {number} [options.refillRate=0]
   * @param {number} [options.refillInterval=1000]
   */
  constructor(options = {}) {
    const {
      capacity = 1,
      tokens = undefined,
      refillRate = 0,
      refillInterval = DEFAULT_REFILL_INTERVAL_MS,
    } = options;
    this.capacity = Math.max(0, Number(capacity) || 0);
    this.tokens = Number.isFinite(tokens) ? Math.min(this.capacity, tokens) : this.capacity;
    this.refillRate = Math.max(0, Number(refillRate) || 0);
    this.refillInterval = Math.max(1, Math.floor(refillInterval) || DEFAULT_REFILL_INTERVAL_MS);

    // track last refill timestamp (ms)
    this._lastRefill = nowMs();
    // accumulate fractional tokens between refills
    this._tokenRemainder = 0;
  }

  /**
   * Internal: advance tokens based on elapsed time.
   * This method computes the number of tokens to add based on the elapsed
   * milliseconds since the last refill and the configured `refillRate`.
   * It accumulates fractional tokens between invocations to preserve precision.
   *
   * @private
   * @param {number} now - current timestamp in milliseconds
   * @returns {void}
   */
  _refill(now) {
    if (this.refillRate <= 0) return;
    const elapsedMs = Math.max(0, now - this._lastRefill);
    if (elapsedMs <= 0) return;
    const tokensToAdd = (elapsedMs / MS_PER_SEC) * this.refillRate + this._tokenRemainder;
    const whole = Math.floor(tokensToAdd);
    this._tokenRemainder = tokensToAdd - whole;
    // advance the last refill timestamp to avoid double-counting elapsed time
    this._lastRefill = now;
    if (whole > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + whole);
    }
  }

  /**
   * Try to consume `n` tokens.
   * @param {number} [n=1]
   * @returns {boolean} `true` when tokens were consumed; `false` otherwise.
   */
  tryConsume(n = 1) {
    const want = Math.max(0, Math.floor(+n) || 0);
    if (want === 0) return true;
    const now = nowMs();
    this._refill(now);
    if (this.tokens >= want) {
      this.tokens -= want;
      return true;
    }
    return false;
  }

  /**
   * Add tokens to the bucket (forceful, useful for tests).
   * @param {number} n
   * @returns {void}
   */
  addTokens(n) {
    const add = Math.max(0, Math.floor(+n) || 0);
    if (add === 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + add);
  }

  /**
   * Reserve `n` tokens without committing them permanently. If successful,
   * returns a token object such as `{ n: 1 }` that may later be passed to
   * `release()` or `rollback()` to return the reserved tokens.
   *
   * Returns `null` when the reservation fails due to insufficient tokens.
   * @param {number} [n=1]
   * @returns {{n:number}|null}
   * @example
   * const token = throttle.reserve(1);
   * if (token) {
   *   // use reserved slot
   *   throttle.release(token);
   * }
   */
  reserve(n = 1) {
    const want = Math.max(0, Math.floor(+n) || 0);
    if (want === 0) return { n: 0 };
    const now = nowMs();
    this._refill(now);
    if (this.tokens >= want) {
      this.tokens -= want;
      return { n: want };
    }
    return null;
  }

  /**
   * Release a prior reservation token or add tokens back.
   * Accepts either a token returned from `reserve()` or a numeric count.
   * @param {object|number} tokenOrN
   * @returns {void}
   * @example
   * const token = throttle.reserve(2);
   * if (token) throttle.release(token);
   * throttle.release(1); // add one token back directly
   */
  release(tokenOrN) {
    let n = 0;
    if (tokenOrN == null) return;
    if (typeof tokenOrN === 'object' && tokenOrN !== null) n = Number(tokenOrN.n) || 0;
    else n = Math.max(0, Math.floor(+tokenOrN) || 0);
    if (n === 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + n);
  }

  // alias for compatibility with undo patterns
  rollback(nOrToken) {
    return this.release(nOrToken);
  }

  /**
   * Current available tokens (performs a refill before reporting).
   * @returns {number}
   */
  available() {
    // perform a refill to present up-to-date value
    this._refill(nowMs());
    return this.tokens;
  }

  /**
   * Reset the bucket to a given token count (or full when omitted).
   * @param {number} [count]
   * @returns {void}
   */
  reset(count) {
    if (count == null) this.tokens = this.capacity;
    else this.tokens = Math.max(0, Math.min(this.capacity, Number(count) || 0));
    this._lastRefill = nowMs();
    this._tokenRemainder = 0;
  }
}
