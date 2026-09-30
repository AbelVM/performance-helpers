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
 * @typedef {import('./jsdoc-types.js').PowerThrottleToken} PowerThrottleToken
 */
import { nowMs } from '../utils/now.js';
import { attachLimiterClock, resolveLimiterNow } from '../utils/limiterClock.js';
import { assertLimitRequired } from '../utils/options.js';
import { DEFAULT_REFILL_INTERVAL_MS, MS_PER_SEC } from './constants.js';

export class PowerThrottle {
  /**
   * See {@link PowerThrottleOptions} for the accepted fields; every default is
   * stated there, because a bare `@param {Object} [options]` here is what let
   * the published type and the destructuring drift apart in the first place.
   *
   * @param {PowerThrottleOptions} [options]
   */
  constructor(options = {}) {
    const {
      capacity = 1,
      tokens = undefined,
      refillRate = 0,
      refillInterval = DEFAULT_REFILL_INTERVAL_MS,
      now,
    } = options;
    // `Math.max(0, Number(x) || 0)` accepted `capacity: 0` - a throttle that
    // can never succeed - and coerced NaN to 0 rather than surfacing it. Both
    // are configuration errors, so they throw.
    this.capacity = assertLimitRequired(capacity, {
      name: 'capacity',
      className: 'PowerThrottle',
      integer: true,
      min: 1,
      fallback: 1,
    });
    // `typeof` narrows; `Number.isFinite` is typed `(number: unknown)` and does
    // not, so `tokens` stayed `number | undefined` at the `Math.min` below.
    this.tokens =
      typeof tokens === 'number' && Number.isFinite(tokens)
        ? Math.min(this.capacity, tokens)
        : this.capacity;
    this.refillRate = assertLimitRequired(refillRate, {
      name: 'refillRate',
      className: 'PowerThrottle',
      min: 0,
      fallback: 0,
    });
    this.refillInterval = assertLimitRequired(refillInterval, {
      name: 'refillInterval',
      className: 'PowerThrottle',
      min: 1,
      fallback: DEFAULT_REFILL_INTERVAL_MS,
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
    attachLimiterClock(this, nowMs, { now }, 'PowerThrottle');

    // track last refill timestamp (ms)
    this._lastRefill = this._now();
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
  tryConsume(n = 1, options = {}) {
    const want = Math.max(0, Math.floor(+n) || 0);
    if (want === 0) return true;
    this._refill(resolveLimiterNow(this._now, this._nowExplicit, options));
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
   * @returns {PowerThrottleToken|null}
   * @example
   * const token = throttle.reserve(1);
   * if (token) {
   *   // use reserved slot
   *   throttle.release(token);
   * }
   */
  reserve(n = 1, options = {}) {
    const want = Math.max(0, Math.floor(+n) || 0);
    if (want === 0) return { n: 0 };
    this._refill(resolveLimiterNow(this._now, this._nowExplicit, options));
    if (this.tokens >= want) {
      this.tokens -= want;
      return { n: want };
    }
    return null;
  }

  /**
   * Release a prior reservation token or add tokens back.
   * Accepts either a token returned from `reserve()` or a numeric count.
   * @param {PowerThrottleToken|number} tokenOrN
   * @returns {void}
   * @example
   * const token = throttle.reserve(2);
   * if (token) throttle.release(token);
   * throttle.release(1); // add one token back directly
   */
  release(tokenOrN) {
    if (tokenOrN == null) return;
    let n;
    if (typeof tokenOrN === 'object' && tokenOrN !== null) n = Number(tokenOrN.n) || 0;
    else n = Math.max(0, Math.floor(+tokenOrN) || 0);
    if (n === 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + n);
  }

  // alias for compatibility with undo patterns
  /**
   * Alias of {@link PowerThrottle#release}.
   * @param {PowerThrottleToken|number} nOrToken
   * @returns {void}
   */
  rollback(nOrToken) {
    return this.release(nOrToken);
  }

  /**
   * Current available tokens (performs a refill before reporting).
   * @returns {number}
   */
  available(options = {}) {
    // perform a refill to present up-to-date value
    this._refill(resolveLimiterNow(this._now, this._nowExplicit, options));
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
    this._lastRefill = this._now();
    this._tokenRemainder = 0;
  }
}
