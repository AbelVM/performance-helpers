import { attach, detach } from './metrics.js';
import { PowerServo } from './powerServo.js';
import { assertLimitRequired, assertKnownOptions } from '../utils/options.js';

/**
 * PowerFlowControl — an adaptive token bucket whose refill rate is set by a
 * closed-loop controller.
 *
 * ## Why this exists
 *
 * A fixed token bucket is a guess. `refillRate: 100` is right for the load you
 * measured and wrong for every other load, and the failure is asymmetric: too
 * low and the bucket starves work that could have run, too high and it stops
 * being a limit at all. Tuning it means re-measuring and redeploying.
 *
 * This helper keeps the bucket and replaces the guess. The refill rate is the
 * output of a {@link PowerServo}, which the caller feeds a measurement of
 * whatever it actually wants to hold steady — queue depth, in-flight count,
 * latency. The bucket then admits work at the rate the controller asks for.
 *
 * ## What the controller is allowed to see
 *
 * The caller supplies the measurement, and that is the whole design constraint,
 * inherited from ADR 0005: this library's other loops each *chose* what to
 * measure, and that choice is where RES-003 and ALGO-010 went wrong. Here the
 * caller owns the measurement and the setpoint, so what is shared is arithmetic
 * that is genuinely identical everywhere.
 *
 * ## What it deliberately does not do
 *
 * It owns **no timer and no clock**. `dt` is an argument to {@link
 * PowerFlowControl#observe}, exactly as it is to `PowerServo.step()`, so the
 * same arithmetic serves a `setInterval` tick, a task-completion callback, or a
 * manual call. Its `dispose()` is therefore a **state reset**, not a teardown.
 *
 * It does not decide *when* to observe. A control loop sampled at the wrong
 * rate is unstable regardless of the gains, and the right sample rate is a
 * property of the plant, not of the bucket.
 *
 * @module powerFlowControl
 * @public
 */
/**
 * @typedef {object} PowerFlowControlOptions
 * @property {number} [capacity=1] - Bucket size, in tokens. The burst a single
 *   refill interval can admit.
 * @property {number} [initialRate=1] - Refill rate the bucket starts at, in
 *   tokens per second, before the first `observe()` moves it.
 * @property {number} [minRate=0] - Lower bound on the adaptive rate. `0` means
 *   the controller may close the bucket entirely.
 * @property {number} [maxRate=Infinity] - Upper bound on the adaptive rate.
 *   Required in practice: an unbounded controller output is not a limit.
 * @property {number} [setpoint=0] - The value `observe()` should hold. Forwarded
 *   to the servo.
 * @property {number} [kp=0] - Proportional gain. Forwarded to the servo.
 * @property {number} [ki=0] - Integral gain. Forwarded to the servo.
 * @property {number} [kd=0] - Derivative gain. Forwarded to the servo.
 * @property {number} [derivativeFilter=0] - Forwarded to the servo.
 * @property {number} [dt=1] - Default sample interval, forwarded to the servo.
 * @property {(rate: number, previous: number) => void} [onRateChange] - Called
 *   when the adaptive rate moves. The hook a caller uses to push the rate into
 *   a pool's concurrency setting.
 * @property {() => number} [now] - Injected clock, as the limiters take
 *   (PERF-007). Defaults to `Date.now`.
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] -
 *   Opt in to metrics. See `guides/metrics.md`.
 */

/**
 * An adaptive token bucket.
 *
 * @public
 * @example
 * const flow = new PowerFlowControl({
 *   capacity: 10,
 *   initialRate: 50,
 *   minRate: 1,
 *   maxRate: 500,
 *   setpoint: 8,
 *   kp: 0.4,
 *   ki: 0.1,
 *   onRateChange: (rate) => pool.setConcurrency(Math.ceil(rate)),
 * });
 *
 * // On a tick, or on every task completion:
 * flow.observe(queue.length, elapsedMs);
 * if (flow.tryConsume(1)) run();
 */
export class PowerFlowControl {
  /**
   * @param {number | PowerFlowControlOptions} [options]
   */
  constructor(options = {}) {
    /** @type {PowerFlowControlOptions} */
    let opts = /** @type {any} */ (options);
    if (typeof options === 'number') {
      opts = { capacity: options };
    }
    assertKnownOptions(
      opts,
      [
        'capacity',
        'initialRate',
        'minRate',
        'maxRate',
        'setpoint',
        'kp',
        'ki',
        'kd',
        'derivativeFilter',
        'dt',
        'onRateChange',
        'now',
        'observability',
      ],
      'PowerFlowControl'
    );
    const capacity = assertLimitRequired(opts.capacity, {
      name: 'capacity',
      className: 'PowerFlowControl',
      min: 1,
      fallback: 1,
    });
    const initialRate = assertLimitRequired(opts.initialRate, {
      name: 'initialRate',
      className: 'PowerFlowControl',
      min: 0,
      fallback: 1,
    });
    const minRate = assertLimitRequired(opts.minRate, {
      name: 'minRate',
      className: 'PowerFlowControl',
      min: 0,
      fallback: 0,
    });
    const maxRate = assertLimitRequired(opts.maxRate, {
      name: 'maxRate',
      className: 'PowerFlowControl',
      min: 0,
      allowInfinity: true,
      fallback: Number.POSITIVE_INFINITY,
    });
    if (maxRate < minRate) {
      throw new RangeError(
        `PowerFlowControl: maxRate (${maxRate}) must be >= minRate (${minRate}). An inverted ` +
          'range has no rate inside it, so every observe() would clamp to a value outside ' +
          'both bounds and the controller would never settle.'
      );
    }
    if (initialRate < minRate || initialRate > maxRate) {
      throw new RangeError(
        `PowerFlowControl: initialRate (${initialRate}) must be within ` +
          `[minRate, maxRate] = [${minRate}, ${maxRate}].`
      );
    }
    this._capacity = capacity;
    // Kept so `reset()` resumes from the rate the caller configured rather than
    // from wherever the controller had moved it. Without it a reset would restart
    // at 0 on a bucket whose minRate is above 0, and the first refill after the
    // reset would admit nothing.
    this._initialRate = initialRate;
    this._minRate = minRate;
    this._maxRate = maxRate;
    this._onRateChange = typeof opts.onRateChange === 'function' ? opts.onRateChange : null;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this._tokens = capacity;
    this._rate = initialRate;
    this._lastRefill = this._now();
    this._tokenRemainder = 0;
    this._observations = 0;
    this._disposed = false;
    // The servo's own bounds are the rate bounds, so the controller cannot ask
    // for a rate the bucket would refuse. That is the integration the row names:
    // without it the two helpers would each clamp independently and disagree.
    this._servo = new PowerServo({
      setpoint: opts.setpoint,
      kp: opts.kp,
      ki: opts.ki,
      kd: opts.kd,
      derivativeFilter: opts.derivativeFilter,
      dt: opts.dt,
      min: minRate,
      max: maxRate,
    });
    this._metrics = attach(this, 'flowControl', opts);
  }

  /**
   * The current adaptive refill rate, in tokens per second.
   * @returns {number}
   */
  get rate() {
    return this._rate;
  }

  /**
   * Tokens currently available.
   * @returns {number}
   */
  get tokens() {
    return this._tokens;
  }

  /**
   * The bucket size.
   * @returns {number}
   */
  get capacity() {
    return this._capacity;
  }

  /**
   * The underlying controller, for a caller that wants to retune it at runtime.
   *
   * Exposed rather than wrapped because the gains are the caller's to set, and a
   * second set of accessors here would be a second place for them to drift.
   * @returns {PowerServo}
   */
  get servo() {
    return this._servo;
  }

  /**
   * Feed the controller one measurement and let it move the rate.
   *
   * @param {number} measured - The process variable, in the servo's own
   *   convention: the controller drives it **toward** `setpoint`, so the output
   *   rises when `measured` is *below* the setpoint and falls when it is above.
   *
   *   **Read that sign carefully, because it is the one thing here a caller
   *   cannot infer.** For flow control the natural quantity to hand a controller
   *   is the queue depth, and a deep queue must produce a *higher* rate — which
   *   is the opposite of what passing the depth directly does. Observe the
   *   **headroom** instead (`capacity - depth`, or `setpoint - depth`), so a deep
   *   queue reads as a small number and the rate rises. `guides/powerFlowControl.md`
   *   works this through with numbers.
   *
   *   Must be finite, exactly as `PowerServo.step()` requires: a NaN measurement
   *   would poison the integrator permanently, and the bucket would then admit at
   *   a rate no comparison can catch.
   * @param {number} [dt] - Elapsed time since the last observation, in the same
   *   unit as the gains. Defaults to the servo's own `dt`.
   * @param {number} [disturbance=0] - A known input the rate must react to
   *   before the measurement moves. The feedforward path's argument.
   * @returns {number} The new rate.
   */
  observe(measured, dt, disturbance = 0) {
    if (this._disposed) return this._rate;
    const next = this._servo.step(measured, dt, disturbance);
    this._observations += 1;
    if (next !== this._rate) {
      const previous = this._rate;
      this._rate = next;
      if (this._onRateChange) {
        try {
          this._onRateChange(next, previous);
        } catch {
          // A throwing rate hook must not stop the observation. The bucket is
          // the helper's state and the rate has already moved; refusing the
          // next observation would freeze the loop at a stale rate, which is
          // the failure the controller exists to prevent.
        }
      }
    }
    return this._rate;
  }

  /**
   * Refill from elapsed time at the current adaptive rate.
   *
   * Lazy, like every other limiter here: no timer, and the elapsed time is
   * computed from a stored timestamp whenever the bucket is read. That is what
   * makes `dispose()` a state reset rather than a teardown.
   * @private
   * @param {number} now
   * @returns {void}
   */
  _refill(now) {
    if (this._rate <= 0) {
      // A closed bucket still advances its timestamp, so reopening it does not
      // release a burst covering the whole closed interval.
      this._lastRefill = now;
      return;
    }
    const elapsedMs = Math.max(0, now - this._lastRefill);
    if (elapsedMs <= 0) return;
    const tokensToAdd = (elapsedMs / 1000) * this._rate + this._tokenRemainder;
    const whole = Math.floor(tokensToAdd);
    this._tokenRemainder = tokensToAdd - whole;
    this._lastRefill = now;
    if (whole > 0) {
      this._tokens = Math.min(this._capacity, this._tokens + whole);
    }
  }

  /**
   * Try to consume `n` tokens.
   * @param {number} [n=1]
   * @returns {boolean} `true` when the tokens were available.
   */
  tryConsume(n = 1) {
    if (this._disposed) return false;
    const want = Math.floor(Number(n));
    if (!Number.isFinite(want) || want < 0) {
      throw new TypeError(
        `PowerFlowControl: \`n\` must be a non-negative finite number (received ${String(n)}).`
      );
    }
    if (want === 0) return true;
    this._refill(this._now());
    if (this._tokens >= want) {
      this._tokens -= want;
      return true;
    }
    return false;
  }

  /**
   * Add tokens directly, bypassing the rate.
   *
   * Exists for the same reason `PowerThrottle.addTokens` does: a test that has
   * to wait for a refill is a test that is slow and flaky in the same way.
   * @param {number} n
   * @returns {void}
   */
  addTokens(n) {
    const add = Math.floor(Number(n));
    if (!Number.isFinite(add) || add < 0) {
      throw new TypeError(
        `PowerFlowControl: \`n\` must be a non-negative finite number (received ${String(n)}).`
      );
    }
    this._tokens = Math.min(this._capacity, this._tokens + add);
  }

  /**
   * Discard all state and resume from the configured initial rate.
   *
   * A state reset, not a teardown: this helper owns no timer and no clock, so
   * there is nothing to cancel. The interface exists so it can take part in
   * `using` / `await using` like every other long-lived helper here.
   * @returns {void}
   */
  reset() {
    this._tokens = this._capacity;
    this._rate = this._initialRate;
    this._lastRefill = this._now();
    this._tokenRemainder = 0;
    this._observations = 0;
    this._servo.reset();
  }

  /**
   * Alias for {@link PowerFlowControl#reset}.
   * @returns {void}
   */
  clear() {
    this.reset();
  }

  /**
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    detach(this._metrics);
    this._metrics = null;
    this._servo.dispose();
    this._onRateChange = null;
    // State cleared, as the sibling helpers do. Leaving a full bucket behind on
    // a disposed instance would let a caller that ignored the refusal below
    // believe it still had capacity.
    this._tokens = 0;
  }

  [Symbol.dispose]() {
    this.dispose();
  }

  async [Symbol.asyncDispose]() {
    this.dispose();
    return;
  }

  /**
   * @returns {object} Counters. `rate` and `tokens` are live state;
   *   `observations` counts controller samples, which is the number to alert on
   *   — a loop that has stopped being fed is a loop whose rate has gone stale.
   */
  stats() {
    return {
      rate: this._rate,
      tokens: this._tokens,
      capacity: this._capacity,
      minRate: this._minRate,
      maxRate: this._maxRate,
      observations: this._observations,
    };
  }

  /**
   * Alias for {@link PowerFlowControl#stats}, matching the rest of the library.
   * @returns {object}
   */
  getStats() {
    return this.stats();
  }
}

export default PowerFlowControl;
