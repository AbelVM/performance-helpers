/**
 * Generic Cell Rate Algorithm (GCRA) rate limiter.
 *
 * GCRA is the cell-based scheduler recommended by the ATM Forum and shipped by
 * `golang.org/x/time/rate`, Redis's `redis-cell` module and the `redis-gcra`
 * Node port. It shapes traffic identically to a token bucket but keeps its
 * entire state in **one integer** - the theoretical arrival time (TAT) - so it
 * is O(1) per call with no accumulator and no rounding drift.
 *
 * ```
 * // on accept:
 * tat = max(now, tat) + emissionInterval
 * accept  iff  now >= tat - delayVariation      (i.e. tat <= now + burst)
 * retryAfter = (tat - burst) - now              exact, not an estimate
 * ```
 *
 * The exact `retryAfter()` is the practical win over {@link PowerThrottle}: a
 * caller can hand it straight to `retryAfter`/`retry-After` instead of
 * guessing, and it composes cleanly with `PowerDeadline` and `PowerRetry`.
 *
 * This module is **additive** - it does not replace or change
 * `PowerThrottle`, whose token accounting remains the default elsewhere.
 *
 * @module powerGCRA
 * @public
 */
import { nowMs } from '../utils/now.js';
import { attachLimiterClock, resolveLimiterNow } from '../utils/limiterClock.js';
import { assertLimitRequired } from '../utils/options.js';

/**
 * @typedef {object} PowerGCRAOptions
 * @property {number} rate - Sustained rate in operations per `per` unit. Must be > 0.
 * @property {number} [per=1000] - The unit `rate` is measured against, in milliseconds.
 * @property {number} [burst=0] - Extra tolerance above the steady-state rate, in
 *   operations. `0` allows exactly the steady-state spacing; larger values admit
 *   a short spike of that many extra operations.
 * @property {function(): number} [now] - Clock override, for tests and for
 *   compositions that read the clock once. Ignored by a composition that
 *   threads its own reading, because an injected clock always wins.
 * @property {function(number):void} [onError] - Called when the internal clock
 *   misbehaves (time moving backwards), instead of throwing.
 */

/**
 * A GCRA rate limiter.
 *
 * @example
 * const limiter = new PowerGCRA({ rate: 100, per: 1000, burst: 10 });
 * if (limiter.tryConsume()) doWork();
 * else setTimeout(doWork, limiter.retryAfter());
 */
export class PowerGCRA {
  /**
   * @param {PowerGCRAOptions} [options] - `rate` is required in practice: the
   *   constructor throws a `TypeError` without it. The parameter stays optional
   *   because that throw is the documented way a missing `rate` is reported, and
   *   `new PowerGCRA()` must stay callable to reach it.
   */
  constructor(options) {
    const { per = 1000, burst = 0, onError = null } = options || {};

    const r = Number(options?.rate);
    if (!Number.isFinite(r) || r <= 0) {
      throw new TypeError('PowerGCRA: `rate` must be a finite number greater than 0');
    }
    assertLimitRequired(per, { name: 'per', className: 'PowerGCRA', min: 1, fallback: 1000 });
    assertLimitRequired(burst, { name: 'burst', className: 'PowerGCRA', min: 0, fallback: 0 });

    this.rate = r;
    this.per = Number(per);
    this.burst = Number(burst);
    this._onError = typeof onError === 'function' ? onError : null;

    // Milliseconds of budget consumed per operation.
    this._emission = this.per / r;
    // Maximum accumulated tolerance, in ms. A request is admitted while
    // `tat <= now + delayTolerance`, so this is what bounds how far the
    // theoretical arrival time may run ahead of the clock.
    this._delayTolerance = this.burst * this._emission;
    // Theoretical arrival time of the next conforming operation, in ms since
    // epoch. `-Infinity` means "no history": the very first call is accepted.
    this._tat = Number.NEGATIVE_INFINITY;
    /**
     * Clock for this limiter, and whether it was explicitly injected. See
     * `resolveLimiterNow` for why the flag is load-bearing: an injected clock
     * must outrank a value threaded in by a composition.
     * @type {(() => number)}
     */
    this._now = nowMs;
    /** @type {boolean} */
    this._nowExplicit = false;
    attachLimiterClock(this, nowMs, /** @type {any} */ (options), 'PowerGCRA');
  }

  /**
   * Try to consume one operation.
   * @param {number} [n=1] - Number of operations to consume.
   * @returns {boolean} `true` when the request fits inside the current budget.
   */
  tryConsume(n = 1, options = {}) {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    if (count === 0) return true;
    const now = resolveLimiterNow(this._now, this._nowExplicit, options);
    const tat = this._tat === Number.NEGATIVE_INFINITY ? now : Math.max(now, this._tat);
    // Admit while the *pre-update* TAT is still inside the tolerance window.
    // Checking the post-update value instead would reserve this request's cost
    // before deciding, which refuses the very first operation.
    if (tat - this._delayTolerance <= now) {
      this._tat = tat + count * this._emission;
      return true;
    }
    // Refuse without committing, so a rejected attempt does not push the next
    // allowed time further out.
    return false;
  }

  /**
   * Exact milliseconds until `tryConsume()` would succeed.
   *
   * @param {number} [n=1] - Number of operations the next call would consume.
   * @returns {number} Milliseconds to wait; `0` when the call would succeed now.
   */
  retryAfter(n = 1, options = {}) {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    if (count === 0) return 0;
    const now = resolveLimiterNow(this._now, this._nowExplicit, options);
    const tat = this._tat === Number.NEGATIVE_INFINITY ? now : Math.max(now, this._tat);
    // GCRA admits a whole batch behind a single admission check, so the wait
    // depends on the current TAT alone and not on `count`. Waiting this long
    // is always sufficient for the entire batch.
    const wait = tat - this._delayTolerance - now;
    return wait <= 0 ? 0 : wait;
  }

  /**
   * Consume, or return the exact wait needed.
   * @param {number} [n=1]
   * @returns {{ok: true} | {ok: false, retryAfter: number}}
   */
  take(n = 1) {
    if (this.tryConsume(n)) return { ok: true };
    return { ok: false, retryAfter: this.retryAfter(n) };
  }

  /**
   * How many operations can be consumed at this instant, given the burst
   * ceiling.
   *
   * A batch is admitted behind a single check, so the count at an idle instant
   * is `burst + 1`, not `burst`: with no history every call up to and including
   * the `burst`-th extra one still finds `tat <= now + delayTolerance`. This
   * also has to be right for composition - `PowerRateLimit` pre-checks
   * `available()` and refuses immediately when it is below the ask, so
   * reporting `0` on a fresh limiter would make GCRA refuse everything.
   *
   * @returns {number} A non-negative whole number.
   */
  available(options = {}) {
    const now = resolveLimiterNow(this._now, this._nowExplicit, options);
    const tat = this._tat === Number.NEGATIVE_INFINITY ? now : Math.max(now, this._tat);
    const remaining = this._delayTolerance - (tat - now);
    if (remaining < 0) return 0;
    return Math.floor(remaining / this._emission) + 1;
  }

  /**
   * Whether the limiter would accept a single operation right now, without
   * consuming it. Same shape as `PowerThrottle.available()` for composition.
   * @returns {boolean}
   */
  get hasCapacity() {
    return this.available() > 0;
  }

  /**
   * Clear the accumulated state, as if the limiter were brand new.
   * @returns {void}
   */
  reset() {
    this._tat = Number.NEGATIVE_INFINITY;
  }

  /**
   * Serializable snapshot of the limiter's configuration and state.
   *
   * `tat` is `null` - not `-Infinity` - when there is no accumulated history
   * (fresh instance, or after `reset()` / `dispose()`), because `-Infinity` does
   * not survive a JSON round-trip: `JSON.stringify` turns it into `null`
   * anyway, so a snapshot that claimed `number` was only true in memory. A
   * consumer that reads the snapshot back therefore already had to handle
   * `null`; the declared type now says so.
   *
   * @returns {{rate:number, per:number, burst:number, emissionInterval:number, delayTolerance:number, tat:number|null}}
   */
  stats() {
    return {
      rate: this.rate,
      per: this.per,
      burst: this.burst,
      emissionInterval: this._emission,
      delayTolerance: this._delayTolerance,
      tat: this._tat === Number.NEGATIVE_INFINITY ? null : this._tat,
    };
  }

  /** @returns {void} */
  dispose() {
    this._tat = Number.NEGATIVE_INFINITY;
  }

  /**
   * Alias for {@link PowerGCRA#reset}.
   *
   * `reset()` here *is* a clear — it discards the one piece of stored state, so
   * both words describe the same act. Contrast the limiters that *hold* capacity
   * (`PowerThrottle`, `PowerPermitGate`), where `reset()` refills and `clear()`
   * would read as the opposite.
   *
   * @returns {void}
   */
  clear() {
    this.reset();
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

export default PowerGCRA;
