/**
 * PowerFlowController — admission, queueing and latency feedback in one loop.
 *
 * The library had three separate answers to "slow down", and none of them was
 * the whole question:
 *
 * - `PowerGCRA` and `PowerThrottle` answer **admission** — at what rate may work
 *   start — at a rate fixed at construction.
 * - `PowerQueue` and `PowerBackpressure` answer **queueing** — how much may wait,
 *   and what happens when it cannot.
 * - `PowerHistogram` answers **measurement** — what the tail latency actually was.
 *
 * A realtime service needs all three wired together: admit at a rate, buffer what
 * does not fit, measure the latency that results, and move the rate. This helper
 * is that loop, and it is a **composition** — `PowerGCRA`, `PowerQueue`,
 * `PowerHistogram` and `PowerServo`, with no new arithmetic of its own beyond
 * deciding when the loop has something to learn.
 *
 * ### The shape
 *
 * ```text
 *   submit(item) ──► bounded queue ──► admit() ──► GCRA ──► caller runs it
 *                                        ▲                    │
 *                                        │                    ▼
 *                                   setRate(rate) ◄── PowerServo ◄── p99
 *                                                             ▲
 *                                                      PowerHistogram
 *                                                             ▲
 *                                                       record(latencyMs)
 * ```
 *
 * The producer side is `submit()`, which bounds the queue and counts what it
 * drops. The consumer side is `admit()`, which is the GCRA gate. The measurement
 * side is `record()`, and the loop is `observe()`.
 *
 * ### Why the latency window resets, and why that is not optional
 *
 * `observe()` reads the p99 of the samples recorded **since the previous
 * `observe()`** and then clears them. A cumulative histogram was measured first
 * and is wrong for this plant: the loop then sees a *lifetime* p99, so a rate
 * that has already been cut keeps being judged against the traffic that
 * justified the cut, and it never comes back. Measured on the plant in
 * `guides/powerFlowController.md`, a cumulative window held the rate at its
 * floor for the whole run while a per-window one converged on the target.
 *
 * The consequence a caller has to know about: **`p99` is the current, partial
 * window**, not a lifetime figure. `latency` exposes the underlying histogram for
 * anyone who wants `snapshot()` or `toJSON()`.
 *
 * ### What it deliberately does not do
 *
 * It owns **no timer and no clock**. `dt` is an argument to `observe()`, exactly
 * as it is to `PowerServo.step()`, so the same arithmetic serves a `setInterval`
 * tick, a task-completion callback, or a manual call. `dispose()` is therefore a
 * state reset and not a teardown.
 *
 * It does not feed **queue depth** to the servo, and that is a decision rather
 * than an omission. Depth is ambiguous in a way latency is not: a deep queue with
 * healthy latency is a backlog to drain, and a deep queue with unhealthy latency
 * is overload to shed, and the same number means both. Delay is the signal the
 * congestion-control literature settled on for exactly this reason. Depth is
 * still here — it is the bound, it is `stats().depth`, and it is the number to
 * alert on — it is just not the process variable.
 *
 * @module powerFlowController
 * @public
 */
import { PowerGCRA } from './powerGCRA.js';
import { PowerHistogram } from './powerHistogram.js';
import { PowerServo } from './powerServo.js';
import { PowerQueue } from './powerQueue.js';
import { attach, detach } from './metrics.js';
import { assertKnownOptions, assertLimitRequired } from '../utils/options.js';
import { neutralise } from '../utils/neutralise.js';
import { DEFAULT_QUEUE_CAPACITY } from './constants.js';

/**
 * @typedef {object} PowerFlowControllerOptions
 * @property {number} rate - Initial sustained rate, in operations per second.
 *   Required: a controller with no starting rate has nothing to clamp.
 * @property {number} [burst=0] - GCRA burst tolerance, in operations. How many
 *   may run back-to-back before the sustained rate applies.
 * @property {number} minRate - Lower bound on the adaptive rate. **Must be
 *   greater than 0.** The actuator is a GCRA, whose rate must be finite and
 *   positive, so "admit nothing" is not a rate this controller can represent — a
 *   caller who wants to stop admitting should stop calling `admit()`.
 * @property {number} [maxRate=Infinity] - Upper bound on the adaptive rate.
 *   Required in practice: an unbounded controller output is not a limit.
 * @property {number} [targetP99=50] - The latency setpoint, in milliseconds. The
 *   servo drives the p99 toward this.
 * @property {number} [quantile=0.99] - Which quantile of the window drives the
 *   loop. `0.99` is the p99; `0.5` would make it a median controller.
 * @property {number} [queueCapacity=100] - Bound on the waiting queue. `submit()`
 *   returns `false` and increments `dropped` when it is full.
 * @property {number} [kp=0.05] - Proportional gain, in (operations per second)
 *   per millisecond of latency error.
 * @property {number} [ki=0.001] - Integral gain. **Non-zero by default, and it
 *   has to be.** With `ki: 0` the output is `kp × error` alone, so a window that
 *   meets its target exactly produces an error of zero and therefore a rate of
 *   zero — which the `minRate` clamp turns into the floor. Measured: P-only
 *   settled at 11% of the rate the plant could sustain at the target latency.
 *   The integrator is what holds the rate up when there is no error left to
 *   correct.
 * @property {number} [kd=0] - Derivative gain, on the measurement. Off by
 *   default: a p99 over a short window is noisy, and differentiating noise is
 *   how a loop starts to oscillate.
 * @property {number} [derivativeFilter=0] - Forwarded to the servo.
 * @property {number} [dt=1] - Default sample interval, forwarded to the servo.
 * @property {number} [relativeAccuracy=0.01] - Forwarded to the histogram.
 * @property {(rate: number, previous: number) => void} [onRateChange] - Called
 *   when the rate moves. The hook for pushing the rate into a pool's concurrency
 *   setting.
 * @property {() => number} [now] - Injected clock, as the limiters take
 *   (PERF-007). Defaults to `Date.now`.
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] -
 *   Opt in to metrics. See `guides/metrics.md`.
 */

/**
 * A closed loop from measured tail latency to an admission rate.
 *
 * @public
 * @example
 * const flow = new PowerFlowController({
 *   rate: 200,
 *   minRate: 5,
 *   maxRate: 800,
 *   targetP99: 30,
 *   kp: 0.05,
 *   ki: 0.001,
 * });
 *
 * // Producer side — bounded, and counted when it drops.
 * if (!flow.submit(job)) dropped++;
 *
 * // Consumer side — the rate gate.
 * const job = flow.admit();
 * if (job) {
 *   const t0 = flow.now();
 *   await run(job);
 *   flow.record(flow.now() - t0);
 * }
 *
 * // The loop, on a tick.
 * flow.observe(elapsedMs);
 */
export class PowerFlowController {
  /**
   * @param {PowerFlowControllerOptions} [options] - `rate` and `minRate` are
   *   required in practice: the constructor throws without either. The parameter
   *   stays optional because those throws are the documented way a missing value
   *   is reported, and `new PowerFlowController()` must stay callable to reach
   *   them.
   */
  constructor(options) {
    // No `= {}` default, and a cast rather than a `Partial<>` on the parameter —
    // both matching `PowerApdex`, which has the same shape of requirement. The
    // options type declares `rate` and `minRate` as required because they *are*
    // required: a caller who omits one gets a throw, not a default. A `= {}`
    // default would therefore be a TS2739 — TypeScript checking `{}` against a
    // type whose two properties are mandatory — for a call the runtime answers
    // correctly with that same throw.
    //
    // The coalesce is here rather than seventeen `?.` sites, and it is not the
    // "second, silently-different answer" `PowerApdex` warns about: that class
    // reads one option, so optional chaining on it is free. This one reads
    // seventeen, and `assertKnownOptions` passes an absent argument straight
    // through — measured, `new PowerFlowController()` reached `opts.rate` and
    // threw `Cannot read properties of undefined`, which is a raw TypeError
    // where the caller is owed the message naming the option.
    /** @type {PowerFlowControllerOptions} */
    const opts = /** @type {any} */ (options ?? {});
    assertKnownOptions(
      opts,
      [
        'rate',
        'burst',
        'minRate',
        'maxRate',
        'targetP99',
        'quantile',
        'queueCapacity',
        'kp',
        'ki',
        'kd',
        'derivativeFilter',
        'dt',
        'relativeAccuracy',
        'onRateChange',
        'now',
        'observability',
      ],
      'PowerFlowController'
    );

    const rate = assertLimitRequired(opts.rate, {
      name: 'rate',
      className: 'PowerFlowController',
      min: 0,
      fallback: 0,
    });
    if (!(rate > 0)) {
      throw new TypeError(
        'PowerFlowController: `rate` must be a finite number greater than 0. ' +
          'A controller with no starting rate has nothing to clamp.'
      );
    }

    const burst = assertLimitRequired(opts.burst, {
      name: 'burst',
      className: 'PowerFlowController',
      min: 0,
      fallback: 0,
    });

    // `minRate > 0` is a hard requirement, not a default. The actuator is a GCRA
    // and `PowerGCRA.setRate()` refuses a non-positive rate, so a `minRate` of 0
    // would be an option the loop cannot honour — it would throw on the first
    // observation that reached the floor. "Admit nothing" is not a rate; a caller
    // who wants that should stop calling `admit()`, which is both simpler and
    // observable.
    const minRate = assertLimitRequired(opts.minRate, {
      name: 'minRate',
      className: 'PowerFlowController',
      min: 0,
      fallback: 0,
    });
    if (!(minRate > 0)) {
      throw new RangeError(
        'PowerFlowController: `minRate` must be greater than 0. The actuator is a ' +
          'GCRA, whose rate must be positive, so a floor of 0 is a rate the loop ' +
          'cannot represent. Stop calling `admit()` to stop admitting.'
      );
    }

    const maxRate = assertLimitRequired(opts.maxRate, {
      name: 'maxRate',
      className: 'PowerFlowController',
      min: 0,
      fallback: Number.POSITIVE_INFINITY,
    });
    if (maxRate < minRate) {
      throw new RangeError(
        `PowerFlowController: maxRate (${maxRate}) must be >= minRate (${minRate}). ` +
          'An inverted range leaves the loop with no output inside it.'
      );
    }
    if (rate < minRate || rate > maxRate) {
      throw new RangeError(
        `PowerFlowController: rate (${rate}) must be within [minRate, maxRate] ` +
          `([${minRate}, ${maxRate}]).`
      );
    }

    const targetP99 = assertLimitRequired(opts.targetP99, {
      name: 'targetP99',
      className: 'PowerFlowController',
      min: 0,
      fallback: 50,
    });
    if (!(targetP99 > 0)) {
      throw new RangeError(
        'PowerFlowController: `targetP99` must be greater than 0. A setpoint of ' +
          'zero is a target no measurement can meet, so the loop would drive the ' +
          'rate to its floor and stay there.'
      );
    }

    const quantile = assertLimitRequired(opts.quantile, {
      name: 'quantile',
      className: 'PowerFlowController',
      min: 0,
      fallback: 0.99,
    });
    if (!(quantile > 0) || quantile > 1) {
      throw new RangeError(
        `PowerFlowController: \`quantile\` must be in (0, 1], received ${String(quantile)}.`
      );
    }

    const queueCapacity = assertLimitRequired(opts.queueCapacity, {
      name: 'queueCapacity',
      className: 'PowerFlowController',
      min: 1,
      integer: true,
      fallback: DEFAULT_QUEUE_CAPACITY,
    });

    /** @type {() => number} */
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;

    this._limiter = new PowerGCRA({
      rate,
      per: 1000,
      burst,
      now: this._now,
    });
    this._queue = new PowerQueue();
    this._latency = new PowerHistogram({
      relativeAccuracy: assertLimitRequired(opts.relativeAccuracy, {
        name: 'relativeAccuracy',
        className: 'PowerFlowController',
        min: 0,
        fallback: 0.01,
      }),
    });
    this._servo = new PowerServo({
      // The setpoint is the latency target and the output is the rate, so the
      // sign needs no inversion: a p99 above the target is a negative error and
      // drives the rate down. That is the opposite of the queue-depth trap
      // `guides/powerFlowControl.md` has to warn about, and it is the reason
      // latency is the process variable here.
      setpoint: targetP99,
      kp: assertLimitRequired(opts.kp, {
        name: 'kp',
        className: 'PowerFlowController',
        min: 0,
        fallback: 0.05,
      }),
      ki: assertLimitRequired(opts.ki, {
        name: 'ki',
        className: 'PowerFlowController',
        min: 0,
        fallback: 0.001,
      }),
      kd: assertLimitRequired(opts.kd, {
        name: 'kd',
        className: 'PowerFlowController',
        min: 0,
        fallback: 0,
      }),
      derivativeFilter: assertLimitRequired(opts.derivativeFilter, {
        name: 'derivativeFilter',
        className: 'PowerFlowController',
        min: 0,
        fallback: 0,
      }),
      dt: assertLimitRequired(opts.dt, {
        name: 'dt',
        className: 'PowerFlowController',
        min: 0,
        fallback: 1,
      }),
      min: minRate,
      max: maxRate,
    });

    this._minRate = minRate;
    this._maxRate = maxRate;
    this._targetP99 = targetP99;
    this._quantile = quantile;
    this._queueCapacity = queueCapacity;
    this._onRateChange = typeof opts.onRateChange === 'function' ? opts.onRateChange : null;

    /** @type {number} */
    this._rate = rate;
    /**
     * The configured starting rate, kept separately from `_rate` because
     * `reset()` has to restore *this* and not `minRate` — a reset means "forget
     * what you learned", and the configured rate is the caller's own statement
     * about what the workload should get.
     * @type {number}
     */
    this._initialRate = rate;
    /** @type {number} */
    this._submitted = 0;
    /** @type {number} */
    this._dropped = 0;
    /** @type {number} */
    this._admitted = 0;
    /** @type {number} */
    this._recorded = 0;
    /** @type {number} */
    this._observations = 0;
    /** @type {boolean} */
    this._disposed = false;

    this._metrics = attach(this, 'flowController', options);
  }

  /** The injected clock, exposed so a caller can time work with the same one. */
  get now() {
    return this._now;
  }

  /** The rate the loop is currently admitting at, in operations per second. */
  get rate() {
    return this._rate;
  }

  /** Lower bound on the adaptive rate. Always greater than 0. */
  get minRate() {
    return this._minRate;
  }

  /** Upper bound on the adaptive rate. */
  get maxRate() {
    return this._maxRate;
  }

  /** The latency setpoint, in milliseconds. */
  get targetP99() {
    return this._targetP99;
  }

  /** Items waiting to be admitted. */
  get depth() {
    return this._queue.length;
  }

  /** Bound on the waiting queue. */
  get queueCapacity() {
    return this._queueCapacity;
  }

  /**
   * Items `submit()` refused because the queue was full.
   *
   * **This is the number to alert on.** A flow controller that is dropping is a
   * flow controller whose rate is too low for the offered load, and nothing else
   * in `stats()` says so — the queue is bounded by design, so a healthy-looking
   * depth is exactly what overload looks like.
   */
  get dropped() {
    return this._dropped;
  }

  /**
   * The p99 of the **current, partial window** — the samples recorded since the
   * last `observe()`. `undefined` when the window is empty.
   *
   * Not a lifetime figure, and deliberately not: see the module docblock on why
   * a cumulative window makes the loop unable to recover.
   */
  get p99() {
    return this._latency.percentile(this._quantile);
  }

  /** The underlying `PowerGCRA`, for `retryAfter()` and direct inspection. */
  get limiter() {
    return this._limiter;
  }

  /** The underlying `PowerServo`, for runtime retuning of the gains. */
  get servo() {
    return this._servo;
  }

  /** The underlying `PowerHistogram`, for `snapshot()` and `toJSON()`. */
  get latency() {
    return this._latency;
  }

  /** The underlying `PowerQueue`. */
  get queue() {
    return this._queue;
  }

  /**
   * Offer an item to the controller.
   *
   * Bounds the queue and counts what it drops. It does **not** consult the rate
   * limiter — the queue is the buffer and `admit()` is the gate, and conflating
   * them would make `depth` mean two different things.
   *
   * @param {any} item - Anything. The controller never inspects it.
   * @returns {boolean} `true` when the item was queued, `false` when the queue
   *   was full and the item was dropped.
   */
  submit(item) {
    if (this._disposed) return false;
    if (this._queue.length >= this._queueCapacity) {
      this._dropped += 1;
      return false;
    }
    this._queue.push(item);
    this._submitted += 1;
    return true;
  }

  /**
   * Take the next item, if the rate limiter admits one.
   *
   * @returns {any} The item, or `null` when the queue is empty or the GCRA
   *   refuses. `null` is not an error — refusing is what a rate limiter is for.
   */
  admit() {
    if (this._disposed) return null;
    if (this._queue.length === 0) return null;
    if (!this._limiter.tryConsume(1)) return null;
    this._admitted += 1;
    return this._queue.shift();
  }

  /**
   * Record one operation's latency, in milliseconds.
   *
   * Negative values are refused rather than clamped: `PowerHistogram.record()`
   * already refuses them, and a caller passing a negative has a clock problem
   * that clamping would hide.
   *
   * @param {number} ms - Elapsed time for one admitted operation.
   * @returns {void}
   */
  record(ms) {
    if (this._disposed) return;
    this._latency.record(ms);
    this._recorded += 1;
  }

  /**
   * Advance the loop by one sample and return the new rate.
   *
   * Reads the p99 of the window, steps the servo, and writes the result into the
   * GCRA. The window is then cleared, so the next observation judges the next
   * window.
   *
   * **An observation with nothing new to measure does not move the rate.** An
   * idle loop has no error to correct, and tuning on stale data is how a
   * controller learns something about a workload that no longer exists — the
   * same rule `PowerBackpressure` applies to its refill heartbeat.
   *
   * @param {number} [dt] - Elapsed time since the last observation, in the same
   *   unit as the gains. Defaults to the servo's own `dt`.
   * @returns {number} The rate after this observation, unchanged when there was
   *   nothing to measure.
   */
  observe(dt) {
    if (this._disposed) return this._rate;
    // The window is cleared by every observation that acts on it, so **any**
    // count above zero is fresh by construction** and no second counter is
    // needed. One was tried — "more samples than the last observation saw" —
    // and it was wrong in the way that matters: `reset()` zeroes `count` but
    // leaves the stored figure where it was, so a window holding exactly as many
    // samples as its predecessor read as *stale* and the loop silently stopped
    // stepping. Measured: 8 admissions produced 3 observations instead of 8.
    // `count`, not `p99 !== undefined`: a window whose only samples are exact
    // zeros has a p99 of `0`, which is a real measurement, and comparing against
    // `undefined` would treat it as empty. The guard is also what narrows
    // `percentile()`'s `number | undefined` for the call below — it returns
    // `undefined` only when the count is zero, which is the case just excluded.
    if (this._latency.count === 0) return this._rate;

    const measured = /** @type {number} */ (this._latency.percentile(this._quantile));
    // Cleared *after* the read, so a `record()` landing between the two cannot
    // be lost, and so the next observation's "is there anything new" test is
    // answered by the histogram's own count rather than by a figure this class
    // has to keep in step with it.
    this._latency.reset();

    const next = this._servo.step(measured, dt);
    this._observations += 1;
    if (next !== this._rate) {
      const previous = this._rate;
      this._rate = next;
      this._limiter.setRate(next);
      if (this._onRateChange) {
        try {
          this._onRateChange(next, previous);
        } catch {
          // A throwing rate hook must not stop the loop. The rate has already
          // moved and the limiter already holds it; refusing the next
          // observation would freeze the controller at a rate the caller was
          // never told about.
        }
      }
    }
    return this._rate;
  }

  /**
   * Current state, as counters.
   *
   * @returns {{rate:number, minRate:number, maxRate:number, targetP99:number, quantile:number, depth:number, queueCapacity:number, submitted:number, admitted:number, recorded:number, dropped:number, observations:number, p99:number|undefined, saturated:boolean}}
   */
  stats() {
    return {
      rate: this._rate,
      minRate: this._minRate,
      maxRate: this._maxRate,
      targetP99: this._targetP99,
      quantile: this._quantile,
      depth: this.depth,
      queueCapacity: this._queueCapacity,
      submitted: this._submitted,
      admitted: this._admitted,
      recorded: this._recorded,
      dropped: this._dropped,
      observations: this._observations,
      p99: this.p99,
      saturated: this._servo.saturated,
    };
  }

  /**
   * Alias for {@link PowerFlowController#stats}.
   *
   * @returns {ReturnType<PowerFlowController['stats']>}
   */
  getStats() {
    return this.stats();
  }

  /**
   * Discard the queue, the latency window and the learned rate.
   *
   * The rate returns to the configured `rate`, not to `minRate`: a reset means
   * "forget what you learned about this workload", and the configured rate is
   * the caller's own statement about what the workload should get.
   *
   * In-flight work is **not** forgotten — the GCRA's theoretical arrival time
   * survives, because the operations it accounts for are still running.
   *
   * @returns {void}
   */
  reset() {
    this._queue.reset();
    this._latency.reset();
    this._servo.reset();
    this._submitted = 0;
    this._dropped = 0;
    this._admitted = 0;
    this._recorded = 0;
    this._observations = 0;
    if (this._rate !== this._initialRate) {
      // Only written when it actually moves, so `reset()` on an
      // already-initial controller does not fire the rate hook.
      const previous = this._rate;
      this._rate = this._initialRate;
      this._limiter.setRate(this._rate);
      if (this._onRateChange) {
        try {
          this._onRateChange(this._rate, previous);
        } catch {
          // As in `observe()`: the rate has already moved.
        }
      }
    }
  }

  /**
   * Alias for {@link PowerFlowController#reset}.
   *
   * Present because `PowerFlowControl` and `PowerQueue` both carry the pair, and
   * a caller reaching for the obvious word on a flow helper should not get a
   * `TypeError`. The two are exact synonyms here — unlike on `PowerThrottle` and
   * `PowerPermitGate`, where `reset()` refills and `clear()` would read as the
   * opposite, this helper has no refill to confuse it with.
   *
   * @returns {void}
   */
  clear() {
    this.reset();
  }

  /**
   * Release every resource this instance holds.
   *
   * Idempotent, and safe to call while the instance is idle. This helper owns no
   * timer, no listener registry and no `FinalizationRegistry` — the GCRA refills
   * lazily from a stored timestamp, the histogram is passive, and the servo
   * advances only when stepped — so this is a **state reset**, not a teardown.
   * Saying "cancels the interval" here would document work that is not
   * happening.
   *
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    // The hook is dropped *before* the reset, not after. `reset()` restores the
    // configured rate, and firing `onRateChange` on the way out would tell a
    // caller to resize a pool for a controller that is being torn down — a
    // callback about an object that no longer exists.
    const hook = this._onRateChange;
    this._onRateChange = null;
    this.reset();
    this._onRateChange = hook;
    detach(this._metrics);
    this._metrics = null;
    // Neutralise the cleanup so a second dispose (or a late call) is a no-op
    // rather than a second teardown pass.
    neutralise(this, 'reset');
  }

  /**
   * Alias for {@link PowerFlowController#dispose}, so `using x = new X()`
   * releases the instance deterministically at scope exit.
   *
   * @returns {void}
   */
  [Symbol.dispose]() {
    this.dispose();
  }

  /**
   * Alias for {@link PowerFlowController#dispose}, for `await using`.
   *
   * @returns {void}
   */
  [Symbol.asyncDispose]() {
    this.dispose();
  }
}

export default PowerFlowController;
