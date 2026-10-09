/**
 * Token-bucket rate limiter.
 * Controls the rate of events by allowing up to `capacity` tokens and
 * refilling at a configured `refillRate`.
 *
 * Options:
 * - `capacity` (number): maximum tokens in the bucket (default 1)
 * - `tokens` (number): initial tokens (default = capacity)
 * - `refillRate` (number): tokens per second to add (default 0)
 * - There is deliberately no `refillInterval`. The bucket refills lazily and
 *   proportionally to elapsed time on every read, so a token is earned every
 *   `1000 / refillRate` ms whether or not anything observes it. An interval
 *   would need a timer and a worse model to express the same arithmetic.
 *
 * @class PowerThrottle
 * @public
 */
/**
 * @typedef {import('./jsdoc-types.js').PowerThrottleOptions} PowerThrottleOptions
 * @typedef {import('./jsdoc-types.js').PowerThrottleToken} PowerThrottleToken
 * @typedef {import('../utils/limiterClock.js').LimiterNowOptions} LimiterNowOptions
 */
import { monoMs } from '../utils/now.js';
import { attachLimiterClock, resolveLimiterNow } from '../utils/limiterClock.js';
import { assertCount, assertLimitRequired, assertKnownOptions } from '../utils/options.js';
import { attach, detach } from './metrics.js';
import { MS_PER_SEC } from './constants.js';

export class PowerThrottle {
  /**
   * See {@link PowerThrottleOptions} for the accepted fields; every default is
   * stated there, because a bare `@param {Object} [options]` here is what let
   * the published type and the destructuring drift apart in the first place.
   *
   * @param {PowerThrottleOptions} [options]
   */
  constructor(options = {}) {
    assertKnownOptions(
      options,
      ['capacity', 'tokens', 'refillRate', 'observability', 'now'],
      'PowerThrottle'
    );
    const { capacity = 1, tokens = undefined, refillRate = 0, now } = options;
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

    /**
     * Clock for this limiter, and whether it was explicitly injected. See
     * `resolveLimiterNow` for why the flag is load-bearing: an injected clock
     * must outrank a value threaded in by a composition.
     * @type {(() => number)}
     */
    this._now = monoMs;
    /** @type {boolean} */
    this._nowExplicit = false;
    attachLimiterClock(this, monoMs, { now }, 'PowerThrottle');

    // track last refill timestamp (ms)
    this._lastRefill = this._now();
    // accumulate fractional tokens between refills
    this._tokenRemainder = 0;
    // Opt-in metrics. Off by default, so the common case allocates nothing and
    // creates no closure.
    this._metrics = attach(this, 'throttle', options);
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
   * @param {LimiterNowOptions} [options] Per-call clock override.
   * @returns {boolean} `true` when tokens were consumed; `false` otherwise.
   */
  tryConsume(n = 1, options = {}) {
    const want = assertCount(n, { name: 'n', className: 'PowerThrottle', method: 'tryConsume' });
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
    const add = assertCount(n, { name: 'n', className: 'PowerThrottle', method: 'addTokens' });
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
   * @param {LimiterNowOptions} [options] Per-call clock override.
   * @returns {PowerThrottleToken|null}
   * @example
   * const token = throttle.reserve(1);
   * if (token) {
   *   // use reserved slot
   *   throttle.release(token);
   * }
   */
  reserve(n = 1, options = {}) {
    const want = assertCount(n, { name: 'n', className: 'PowerThrottle', method: 'reserve' });
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
   * @param {LimiterNowOptions} [options] Per-call clock override.
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

  /**
   * Serializable snapshot of the bucket's configuration and current state.
   *
   * **It refills first, which is the whole reason this is not a field read.**
   * `this.tokens` is only ever correct as of the last read: nothing advances it
   * between calls, so a snapshot taken a minute after the last `tryConsume`
   * would report an exhausted bucket that has in fact refilled to capacity. That
   * is the wrong direction to be wrong in — a dashboard showing "0 tokens
   * available" for a bucket that will admit a request is a page that sends
   * someone to debug a limiter that is working — so this asks the bucket what it
   * holds now, the same question `available()` asks.
   *
   * Reported as configuration plus one state field rather than as allow/refuse
   * counters, and that follows `PowerGCRA.stats()` deliberately: a counter would
   * mean incrementing a field on `tryConsume`, the hot synchronous path, for
   * something that is off by default. The bucket's own state is the measurement;
   * how many requests arrived is the caller's to count.
   *
   * @returns {{capacity:number, tokens:number, refillRate:number}}
   */
  stats() {
    this._refill(this._now());
    return {
      capacity: this.capacity,
      tokens: this.tokens,
      refillRate: this.refillRate,
    };
  }

  /**
   * Alias for {@link stats}.
   *
   * See `guides/stats-naming.md` for why both spellings exist and why this
   * method is written out per class.
   */
  getStats() {
    return this.stats();
  }

  /**
   * Release every resource this instance holds.
   *
   * A throttle holds no timer and no subscription — it refills lazily, computing
   * the elapsed time from `_lastRefill` whenever it is read. So there is nothing
   * to tear down, and this is a **state reset**, not a cleanup: a half-spent
   * bucket is dropped and `_lastRefill` re-seeds, so a disposed-then-reused
   * throttle does not immediately admit a request the previous instance
   * "spent".
   *
   * It exists because `PowerThrottle` is a helper a caller holds for the
   * process lifetime, and without `dispose()` it cannot take part in `using` /
   * `await using` or a DI container's teardown — the one shape every other
   * long-lived helper here supports.
   *
   * A metrics registration is one of the things it releases. The collector holds
   * a closure over this instance, so an observability-enabled throttle that is
   * disposed without unregistering is sampled forever — and a throttle still
   * answers `stats()` afterwards, so nothing fails visibly while the series
   * quietly reports a dead object. Safe to call on a throttle that never
   * attached: `detach(null)` returns `false`.
   *
   * @returns {void}
   */
  dispose() {
    detach(this._metrics);
    this._metrics = null;
    this.reset();
  }

  /**
   * Alias for {@link dispose}, so `using x = new PowerThrottle(…)` releases it
   * deterministically at scope exit.
   *
   * @returns {void}
   */
  [Symbol.dispose]() {
    this.dispose();
  }

  /**
   * Asynchronous disposal hook (thin wrapper). Forwards to sync disposal.
   * @returns {Promise<void>}
   */
  async [Symbol.asyncDispose]() {
    this.dispose();
    return;
  }
}
