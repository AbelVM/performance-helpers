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
 * tat = max(now, tat) + n * emissionInterval
 * accept  iff  tat + (n - 1) * emissionInterval - delayVariation <= now
 * retryAfter = (tat - delayVariation) - now + (n - 1) * emissionInterval
 * ```
 *
 * A batch of `n` is admitted only if its **own span** — `(n - 1)` emission
 * intervals — fits inside the delay tolerance, which is the same requirement
 * `golang.org/x/time/rate` encodes as `n <= burst`. So the steady-state shape
 * above is the `n = 1` case, and `available()` is the count of how many
 * operations the current budget really covers.
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
import { monoMs } from '../utils/now.js';
import { attach, detach } from './metrics.js';
import { attachLimiterClock, resolveLimiterNow } from '../utils/limiterClock.js';
import { assertCount, assertLimitRequired, assertKnownOptions } from '../utils/options.js';

/**
 */
/**
 * @typedef {object} PowerGCRAOptions
 * @property {number} rate - Sustained rate in operations per `per` unit. Must be > 0.
 * @property {number} [per=1000] - The unit `rate` is measured against, in milliseconds.
 * @property {number} [burst=0] - Extra tolerance above the steady-state rate, in
 *   operations. `0` allows exactly the steady-state spacing; larger values admit
 *   a short spike of that many extra operations.
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] - Opt in to
 *   metrics: `true` registers this limiter in the shared collector, or pass a collector of
 *   your own. Off by default, so the common case allocates nothing.
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
    // Cast rather than `options ?? {}`: the parameter is deliberately optional so
    // that `new PowerGCRA()` stays callable and throws its documented TypeError, so
    // `assertKnownOptions` already handles the absent case on its own. Coalescing
    // here would be a second, silently-different answer to the same question.
    assertKnownOptions(
      /** @type {object} */ (options),
      ['rate', 'per', 'burst', 'observability', 'now', 'onError'],
      'PowerGCRA'
    );
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
    this._now = monoMs;
    /** @type {boolean} */
    this._nowExplicit = false;
    attachLimiterClock(this, monoMs, /** @type {any} */ (options), 'PowerGCRA');
    // The last clock reading this limiter saw, or `null` before the first one.
    // It is what `onError` compares against, so that a report means "the clock
    // moved backwards" rather than "the limiter is rate-limiting" — see the
    // note in `tryConsume`.
    /** @type {?number} */
    this._lastNow = null;
    // FEAT-007: opt-in metrics. Off by default, so the common case pays nothing and allocates no closure.
    this._metrics = attach(this, 'gcra', options);
  }

  /**
   * Try to consume one operation.
   * @param {number} [n=1] - Number of operations to consume.
   * @returns {boolean} `true` when the request fits inside the current budget.
   */
  /**
   * Report a backwards clock, without ever letting the report break admission.
   *
   * The clamp in {@link tryConsume} already prevents a backwards clock from
   * admitting unbounded traffic, so this is observability, not safety. It is
   * individually guarded because a throwing `onError` would replace a rate-limit
   * decision with a callback error, and the caller would see an exception where
   * the limiter had a perfectly good answer.
   *
   * @param {number} now - The offending clock reading.
   * @returns {void}
   * @private
   */
  _notifyClock(now) {
    if (!this._onError) return;
    try {
      this._onError(now);
    } catch {
      /* a user's error handler must not break admission */
    }
  }

  /**
   * @param {number} [n=1]
   * @param {import('../utils/limiterClock.js').LimiterNowOptions} [options]
   *   Per-call clock override.
   * @returns {boolean}
   */
  tryConsume(n = 1, options = {}) {
    const count = assertCount(n, { name: 'n', className: 'PowerGCRA', method: 'tryConsume' });
    if (count === 0) return true;
    const now = resolveLimiterNow(this._now, this._nowExplicit, options);
    // A clock that moved backwards relative to the TAT means the injected or
    // system clock was adjusted (NTP, a suspended host, a test driving it by
    // hand). The clamp below is what stops that admitting unbounded traffic, and
    // it is silent — which is why `onError` shipped as an option nobody was ever
    // called on. It is called now, with the offending reading, so a limiter on a
    // clock that jumps is *visible* rather than merely safe. Still no throw, which
    // is what the option documents.
    //
    // **The predicate used to be `now < this._tat`, and that reported the
    // limiter working.** A TAT ahead of `now` is the *normal saturated state* —
    // it is exactly what a limiter looks like when it is rate-limiting — so every
    // ordinary refusal fired `onError`. Measured at `rate: 1, capacity: 1`,
    // 19 refusals produced 19 calls with a raw number as the argument, on a
    // perfectly healthy clock. A correct limiter therefore looks broken to
    // anything wired to `onError`, which is the opposite of what an
    // observability option is for.
    //
    // What a backwards clock actually looks like is the *reading itself* moving
    // backwards, which is why this compares against the last reading taken and
    // not against the TAT. `null` means "no previous reading", so the first call
    // after construction never reports. Still no throw.
    //
    // The anchor for this edit is the whole `tryConsume` preamble rather than the
    // two lines alone: that pair of lines appears in three consume-shaped methods
    // here, so a looser anchor matched all three and the edit had to be narrowed.
    if (this._lastNow !== null && now < this._lastNow) {
      this._notifyClock(now);
    }
    this._lastNow = now;
    const tat = this._tatAt(now);
    // Admit the whole batch, or none of it: the batch's own span has to fit
    // inside the tolerance window. `available()` already measures exactly that,
    // and this is the same predicate as `available() >= count` — which is the
    // requirement `golang.org/x/time/rate` states as `n <= burst`.
    //
    // Both halves are computed from **one** helper rather than inlined. That is
    // not tidiness: written out separately, the two disagree on real
    // configurations. Measured over `rate` 1-40 × `burst` 0-12 × `n` 1-16 with
    // varied history, the float error between the two spellings made 255
    // combinations admit a batch that `available()` had just reported as
    // unaffordable — e.g. at `rate: 7, burst: 8, n: 5`,
    // `remaining / emission` came to `3.9999999999995346` (so `available()`
    // said 4, refuse) while `remaining >= 4 * emission` was `571.4285714285049
    // >= 571.4285714285714` (so it admitted). One arithmetic, one answer.
    //
    // Checking the *post*-update TAT instead would reserve this request's cost
    // before deciding, which refuses the very first operation.
    if (this._covers(tat, now) >= count) {
      this._tat = tat + count * this._emission;
      return true;
    }
    // Refuse without committing, so a rejected attempt does not push the next
    // allowed time further out.
    return false;
  }

  /**
   * Exact milliseconds until `tryConsume(n)` would succeed.
   *
   * Grows with `n`, by `(n - 1) * emissionInterval` beyond the single-operation
   * wait. That is the batch's own span and it has to: a batch is admitted only
   * when the whole span fits inside the tolerance window, so waiting the
   * single-operation wait and then asking for five would be refused. The wait
   * this returns is the exact boundary — not an estimate, and not a value that
   * under-waits.
   *
   * @param {number} [n=1] - Number of operations the next call would consume.
   * @param {import('../utils/limiterClock.js').LimiterNowOptions} [options]
   *   Per-call clock override.
   * @returns {number} Milliseconds to wait; `0` when the call would succeed now.
   */
  retryAfter(n = 1, options = {}) {
    const count = assertCount(n, { name: 'n', className: 'PowerGCRA', method: 'retryAfter' });
    if (count === 0) return 0;
    const ceiling = this._ceiling();
    if (count > ceiling) {
      throw new RangeError(
        `PowerGCRA.retryAfter(): cannot ever admit ${count} operations - the ` +
          `configured burst covers at most ${ceiling} at any instant. Waiting ` +
          'cannot make it fit, so there is no honest wait to report. Split the ' +
          'batch, or raise `burst`.'
      );
    }
    const now = resolveLimiterNow(this._now, this._nowExplicit, options);
    // The *same* `remaining` the admission check measures, and the same
    // subtraction. Written out the other way round - `tat - delayTolerance -
    // now + (count - 1) * emission` - the two are algebraically identical and
    // differ in the last bit, which was enough to make this report `0` while
    // the next `tryConsume` refused (and to under-wait by ~1e-11 ms elsewhere).
    const remaining = this._remainingAt(this._tatAt(now), now);
    const wait = (count - 1) * this._emission - remaining;
    return wait <= 0 ? 0 : wait;
  }

  /**
   * Consume, and on refusal report **the exact time** the batch would be admitted.
   *
   * The capability is not missing — {@link PowerGCRA#retryAfter} already computes
   * the exact wait. What is missing is doing both **from one clock reading**:
   * `tryConsume()` followed by `retryAfter()` takes two, and this class's own
   * comments record that two spellings of the same arithmetic have already
   * disagreed in the last bit and admitted a batch `available()` had just called
   * unaffordable. A caller wiring an HTTP 429 needs both answers at once anyway.
   *
   * `runAt` is an **absolute timestamp**, not a delay — an HTTP `Retry-After` and a
   * log line both want the instant, and converting one to the other is where a
   * caller gets it wrong. It is `null` on success because there is nothing to wait
   * for.
   *
   * This mirrors `tryConsume`'s admission path line for line rather than calling
   * it, because calling it would cost the second reading this method exists to
   * avoid. `test/powerGCRA.test.js` asserts the two agree across a spread of
   * configurations, so a future change to either one that the other does not
   * follow fails rather than drifting.
   *
   * @param {number} [n=1] - Number of operations to reserve.
   * @param {import('../utils/limiterClock.js').LimiterNowOptions} [options]
   *   Per-call clock override.
   * @returns {{ok: true, runAt: null} | {ok: false, runAt: number}} `runAt` is the
   *   absolute time the refused batch would be admitted.
   */
  tryReserve(n = 1, options = {}) {
    const count = assertCount(n, { name: 'n', className: 'PowerGCRA', method: 'tryReserve' });
    if (count === 0) return { ok: true, runAt: null };
    const now = resolveLimiterNow(this._now, this._nowExplicit, options);
    // Same backwards-clock handling as `tryConsume`: the *reading* moving backwards
    // is what is reported, and it is reported rather than thrown.
    if (this._lastNow !== null && now < this._lastNow) {
      this._notifyClock(now);
    }
    this._lastNow = now;
    const tat = this._tatAt(now);
    if (this._covers(tat, now) >= count) {
      this._tat = tat + count * this._emission;
      return { ok: true, runAt: null };
    }
    // Refuse without committing, exactly as `tryConsume` does, so a rejected
    // reservation does not push the next allowed time further out.
    //
    // The same `remaining`, and the same subtraction, that `retryAfter` uses —
    // written the other way round they are algebraically identical and differ in
    // the last bit, which was enough to report `0` while the next `tryConsume`
    // refused. From *this* reading, so the two answers cannot straddle a tick.
    const remaining = this._remainingAt(tat, now);
    const wait = (count - 1) * this._emission - remaining;
    return { ok: false, runAt: now + (wait > 0 ? wait : 0) };
  }

  /**
   * The largest batch this limiter will admit at any instant, at any wait.
   *
   * {@link PowerGCRA#_covers} saturates here, so an ask above it is not merely
   * refused *now* — no amount of waiting admits it, because the ceiling is set
   * by `burst` and not by the state of the TAT. Measured over `rate` 1-30 ×
   * `burst` 0-10, a batch one past the ceiling was admitted at **no** wait out
   * of 200 000 tried, per configuration.
   *
   * `burst` is not asserted integral (a fractional burst is a legitimate
   * sub-operation tolerance), so the ceiling floors. A fractional `burst` rounds
   * *down* here and up in `_delayTolerance`, which is the safe direction: it
   * never claims capacity that the check will not honour.
   *
   * @returns {number} A whole number of operations, at least 1.
   * @private
   */
  _ceiling() {
    return Math.floor(this.burst) + 1;
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
   * @param {import('../utils/limiterClock.js').LimiterNowOptions} [options]
   *   Per-call clock override.
   * @returns {number} A non-negative whole number.
   */
  available(options = {}) {
    const now = resolveLimiterNow(this._now, this._nowExplicit, options);
    return this._covers(this._tatAt(now), now);
  }

  /**
   * How many operations the budget at `now` covers, given the pre-update TAT.
   *
   * The single source of truth for admission. `tryConsume` compares against
   * `count` and `available()` returns it, so the two cannot disagree — which is
   * the point, because as separate expressions they did: `floor(remaining /
   * emission) + 1` and `remaining >= (n - 1) * emission` are equal in exact
   * arithmetic and *not* in floating point, and the disagreement showed up as a
   * limiter admitting a batch its own `available()` had just refused.
   *
   * The `+ 1` is not slack. The check is made against the *pre-update* TAT, so
   * at an idle instant the very first operation always fits, and an idle
   * `burst: b` limiter covers `b + 1` operations back to back. `PowerRateLimit`
   * depends on that number: it pre-checks `available() < want` and refuses
   * without calling `tryConsume`, so reporting `0` on a fresh limiter would
   * make GCRA refuse everything once composed.
   *
   * @param {number} tat - Pre-update TAT, from {@link PowerGCRA#_tatAt}.
   * @param {number} now - Current clock reading in ms.
   * @returns {number} A non-negative whole number of operations.
   * @private
   */
  _covers(tat, now) {
    const remaining = this._remainingAt(tat, now);
    if (remaining < 0) return 0;
    // Saturated: the TAT is at or behind the clock, so the whole burst is
    // there. Answered from `burst` rather than by dividing `delayTolerance`
    // back by `emission`, because that round trip does not survive floating
    // point — at `rate: 3, burst: 7` the quotient reads `6.999999999999999`
    // and the limiter reported 7 operations available where it covers 8. That
    // was not merely a reporting nit: `PowerRateLimit` pre-checks
    // `available() < want` and refuses, so a composition holding this limiter
    // turned down a batch the limiter itself would have admitted.
    if (remaining >= this._delayTolerance) return this._ceiling();
    return Math.floor(remaining / this._emission) + 1;
  }

  /**
   * Milliseconds of tolerance still unspent at `now`, given the pre-update TAT.
   *
   * Extracted so admission, availability and {@link PowerGCRA#retryAfter} all
   * read the same number by the same subtraction. Each of them had its own
   * spelling before, and the three disagreed in the last bit — see
   * {@link PowerGCRA#retryAfter}.
   *
   * @param {number} tat - Pre-update TAT, from {@link PowerGCRA#_tatAt}.
   * @param {number} now - Current clock reading in ms.
   * @returns {number} Milliseconds remaining; negative when the TAT is ahead.
   * @private
   */
  _remainingAt(tat, now) {
    return this._delayTolerance - (tat - now);
  }

  /**
   * The pre-update TAT at `now`, clamped so it never sits in the past.
   *
   * Three methods need this exact pair — `tryConsume`, `retryAfter` and
   * `available` — and the `-Infinity` sentinel is what distinguishes "no
   * history" from "history that a backwards clock put behind us". Inlining it
   * three times is how the batch check came to omit its own span: the clamping
   * was duplicated but the predicate was not.
   *
   * @param {number} now - Current clock reading in ms.
   * @returns {number} The TAT to decide against.
   * @private
   */
  _tatAt(now) {
    return this._tat === Number.NEGATIVE_INFINITY ? now : Math.max(now, this._tat);
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

  /**
   * Alias for {@link stats}.
   *
   * See `guides/stats-naming.md` for why both spellings exist and why this
   * method is written out per class.
   */
  getStats() {
    return this.stats();
  }

  /** @returns {void} */
  dispose() {
    detach(this._metrics);
    this._metrics = null;
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

  async [Symbol.asyncDispose]() {
    this.dispose();
    return;
  }
}

export default PowerGCRA;
