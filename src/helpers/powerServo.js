/**
 * PowerServo — a closed-loop transfer function.
 *
 * Implements the classical two-degree-of-freedom controller shape:
 *
 * ```text
 *   u = feedforward(disturbance) + C(s) · (setpoint − measured)
 * ```
 *
 * where `C(s)` is PI by default, and where **the caller supplies both terms of
 * the error**. That is the whole design constraint, and it is the line ADR 0005
 * draws: this library's other three loops each *choose* what to measure, and
 * that choice is where `RES-003` and `ALGO-010` went wrong. Here the caller owns
 * the measurement and the setpoint, so what is shared is arithmetic that is
 * genuinely identical everywhere — an integrator that must not wind up, a
 * derivative that must not kick, and output bounds — with no knob that any
 * caller leaves unset.
 *
 * What this buys over twenty lines of hand-rolled PI, in order of how often it
 * bites:
 *
 * 1. **The derivative is taken on the measurement, not on the error.** Differentiating
 *    `setpoint − measured` produces an unbounded spike the instant the setpoint
 *    moves, which is the single most common way a hand-rolled PID overshoots.
 *    Here a setpoint step produces *no* derivative term at all.
 * 2. **The derivative is low-pass filtered.** Raw numerical differentiation
 *    amplifies measurement noise by the ratio of signal to sample rate, and
 *    `derivativeFilter` is the knob that stops it.
 * 3. **The integrator cannot wind up.** The integral may only push the output
 *    inside `[min, max]`, so a controller that was blocked at `max` for a long
 *    time does not then sit at `max` for a long time after it unblocks — it
 *    releases on the first step.
 *
 * The helper owns **no timer and no clock**: `dt` is an argument, so the same
 * arithmetic serves a `setInterval` tick, a task-completion callback, or a
 * manual `step()`. Its `dispose()` is therefore a state reset and not a
 * teardown — see {@link PowerServo#dispose}.
 *
 * ### It cannot diverge
 *
 * Worth stating because a control helper that diverges is the failure everyone
 * fears, and this one cannot: **the output is clamped to `[min, max]` on every
 * step**, and the integral is clamped so it can only ever push the output
 * *within* those bounds. There is no gain configuration that escapes, because
 * the clamp does not consult the gains for its bounds — only for which part of
 * the window the integral may occupy.
 *
 * What that sweep actually establishes, stated precisely because the difference
 * matters and the looser version of it was wrong once: across `kp` 0.2→6, `ki`
 * and `kd` on and off, and sample intervals 100 ms→1 ms against a 200 ms lag with
 * 300 ms of transport delay, **the output stayed inside `[min, max]` and the
 * integral stayed bounded in all 90 combinations. The loop did not converge in
 * all of them.** It converges for `kp` up to 1.5 at every interval, and outside
 * that band it limit-cycles — `kp: 3` at `dt: 100`, and `kp: 6` at `dt: 10` and
 * `dt: 1`, swing the full 0→100 every two seconds for as long as they are run
 * (measured over 20 s). That is not a defect in the arithmetic; 300 ms of pure
 * dead time caps the loop gain near `tau / delay`, so those are unstable tunings
 * on that plant and any PI would do it. The clamp is what keeps an unstable
 * tuning *bounded* instead of divergent, and `saturated` is `true` throughout.
 * A caller on a delayed plant gets a loud loop rather than a quiet wrong one.
 *
 * What bounds the *rate* of change is the same arithmetic: the output can move
 * by at most `|kp·Δmeasured| + |ki·error|·dt + |kd·Δmeasured|/dt` in one step,
 * and every one of those is set by the caller's own gains and data. The helper
 * contributes no unboundedness of its own.
 *
 * **A slew limit (`maxDelta`) was implemented here and removed.** The claim that
 * motivated it was that running gains tuned for a coarse sample at a 100x finer
 * one makes the output "chatter" — 128 changes at `dt = 100` against 5997 at
 * `dt = 1`, on a 200 ms lag / 300 ms delay plant. That count is real and the
 * conclusion drawn from it was not: it counted a 0.5-unit move as chatter. On a
 * 100-wide output the **largest single move was 0.5**, total variation was 40,
 * and the limit made settling *worse* (total variation 98 with `maxDelta: 2`,
 * because it delayed the approach and kept the loop moving). So there was no
 * thrash to fix, and an option accepted on a measurement of the wrong quantity is
 * the failure `AGENTS.md` calls decoration. Recorded rather than deleted so the
 * next proposal does not re-derive it from the same bad metric.
 *
 * **These figures only hold for the tail, and measuring the whole run gives the
 * opposite answer.** Re-measured at `kp: 0.6, ki: 0.02` on the plant above, the
 * largest single move over the run including the setpoint step is 60 — because the
 * first sample answers a 100-unit error with `kp × 100`, which is the correct
 * response and not chatter — and `maxDelta: 2` *lowers* total variation there
 * (149 → 100) by capping exactly that step. Excluding the transient reproduces the
 * recorded direction: largest move 0.161 and variation 0.4 without the limit
 * against 8.0 with it. Anyone re-measuring this must state which window they
 * counted, because the two windows disagree about whether the limit helps.
 *
 * The genuinely unrecoverable input was a non-finite number reaching the loop,
 * and every route to one is closed: `measured` and a `feedforward` return throw,
 * `setpoint`, `min` and `max` validate on assignment, the integral clamp will not
 * divide into an infinity, and the derivative will not divide by a zero-length
 * span. Five were found by probe and four were silent — the fifth, `dt: 0` with
 * a nonzero `kd`, was the loud one and is described at the derivative in
 * {@link PowerServo#step}.
 *
 * Note what the stability sweep above does *not* cover, since it is the obvious
 * next question: it ran sample intervals of 100 ms to 1 ms. `dt: 0` is not a
 * coarse tick, it is the claim that no time passes between samples, and it was
 * inside the accepted option range the whole time.
 *
 * @class PowerServo
 * @public
 *
 * @example
 * // Hold a queue at a depth of 8 items, feeding the disturbance forward.
 * const servo = new PowerServo({ setpoint: 8, kp: 0.4, ki: 0.1, min: 1, max: 64 });
 * const consumers = servo.step(queue.length, elapsedMs, queue.arrivalsPerMs);
 * pool.setConcurrency(consumers);
 */
import { assertKnownOptions } from '../utils/options.js';

export class PowerServo {
  /**
   * @typedef {import('./jsdoc-types.js').PowerServoOptions} PowerServoOptions
   */
  /**
   * @param {PowerServoOptions} [options]
   */
  constructor(options = {}) {
    assertKnownOptions(
      options,
      [
        'setpoint',
        'kp',
        'ki',
        'kd',
        'derivativeFilter',
        'min',
        'max',
        'feedforward',
        'feedforwardGain',
        'dt',
      ],
      'PowerServo'
    );

    // **`setpoint`, `min` and `max` are assigned through their setters** below,
    // not to the fields directly, so the validation is the same on the
    // constructor path as on every later assignment. That matters because these
    // three are public and writable — they are meant to be retuned at runtime —
    // and an unguarded write was four separate ways to make the loop
    // unrecoverable. See the setters.
    // Three assignment routes to an unrecoverable state were found by measurement
    // and all three were silent — see the accessors. They matter because the
    // constructor validated its arguments and the *fields* did not: these are
    // public and writable, so a runtime retune bypassed every check.
    //
    // `_setpoint` is declared here rather than only in the setter, because TS
    // cannot see that the constructor reaches the setter and so types the getter
    // as `number | undefined` — a `TS2322` at `return this._setpoint`.
    /** @type {number} */
    this._setpoint = 0;
    this.setpoint = finite(options.setpoint, 0);
    /** @type {number} - Proportional gain. */
    this._kp = finite(options.kp, 0);
    /** @type {number} - Integral gain. Zero disables the integrator entirely. */
    this._ki = finite(options.ki, 0);
    /** @type {number} - Derivative gain. Zero disables the derivative path. */
    this._kd = finite(options.kd, 0);
    /**
     * First-order low-pass coefficient on the derivative term, in `[0, 1)`.
     * `0` filters nothing (raw differentiation); values near `1` make the
     * derivative very slow. Ignored when `kd` is `0`.
     */
    this._derivativeFilter = clampRange(finite(options.derivativeFilter, 0), 0, 0.999);

    // `_min` / `_max` are set directly rather than through their setters,
    // because both setters validate against the *other* bound and neither exists
    // yet. `bound()` plus the explicit range check below is the same validation
    // the setters perform.
    this._min = bound(options.min, -Infinity, Number.NEGATIVE_INFINITY, Infinity);
    this._max = bound(options.max, Infinity, Number.NEGATIVE_INFINITY, Infinity);
    // An inverted range has no output inside it, so every step would clamp to a
    // value outside `[min, max]` and the integral clamp would compute a window
    // with its ends the wrong way round. Checked here *and* in both setters,
    // because a range inverted from the outside is the same defect arriving
    // later. Measured: writing `max = -50` while `min` was `0` produced an
    // output of `-50` — outside both bounds — and let the integral run to 1978,
    // because every `contribution < lo` comparison against a NaN-free but
    // inverted window failed and the clamp never fired.
    if (this.max < this.min) {
      throw new RangeError(`PowerServo: max (${this.max}) must be >= min (${this.min})`);
    }

    const ff = options.feedforward;
    if (ff !== undefined && ff !== null && typeof ff !== 'function' && typeof ff !== 'number') {
      throw new TypeError(
        `PowerServo: feedforward must be a function or a number, got ${typeof ff}`
      );
    }
    /** @type {Function|number|null} - Open-loop term, ahead of the error. */
    this._feedforward = ff ?? null;
    /**
     * Static-gain form of the feedforward path, applied to `disturbance` when
     * `feedforward` is not a function. Setting it implies
     * `feedforward: (d) => d * gain`.
     */
    this._feedforwardGain = finite(options.feedforwardGain, 0);

    /**
     * Default `dt` for {@link PowerServo#step}, in whatever time unit the gains
     * are expressed in. `1` makes a controller that ignores wall time behave
     * correctly for a fixed-rate tick, and callers on a real clock should pass
     * their own elapsed time instead.
     */
    this._defaultDt = Math.max(0, finite(options.dt, 1));

    this._integral = 0;
    this._previousMeasured = null;
    this._derivative = 0;
    this._output = 0;
    this._error = 0;
    this._saturated = false;
  }

  /**
   * The reference `r`. Writable at any time.
   *
   * Validated on assignment, which is the point of it being an accessor rather
   * than a field. `NaN` here is the one input that makes the loop
   * **unrecoverable**: `error` becomes `NaN`, `clamp` cannot catch it because
   * `NaN` is neither `<` nor `>` anything, and the integral then accumulates
   * `NaN` forever. Measured: assigning `servo.setpoint = NaN` for one step and
   * then restoring it left `output` and `integral` at `NaN` for the rest of the
   * object's life. Refusing the assignment is the only version of this that
   * leaves the controller usable.
   *
   * @type {number}
   */
  get setpoint() {
    return this._setpoint;
  }

  set setpoint(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      // Finite, not merely "not NaN": an infinite setpoint makes `error`
      // infinite, `kp * error` infinite, and then `this._integral += error * h`
      // puts an infinity into the integral — and `clamp` cannot catch that
      // either. Same unrecoverable state, one step later.
      throw new TypeError(`PowerServo: setpoint must be a finite number, got ${value}`);
    }
    this._setpoint = value;
  }

  /**
   * Lower output bound. `-Infinity` for no lower bound.
   *
   * Validated on assignment for the same reason {@link PowerServo#setpoint} is:
   * a `NaN` bound silently **disables** the clamp, because every
   * `contribution < lo` comparison against `NaN` is false. Measured: with
   * `max = NaN` the loop happily wound its integral to 1978 with the output
   * stuck at 0, which is the windup bug with the guard that prevents it removed.
   *
   * @type {number}
   */
  get min() {
    return this._min;
  }

  set min(value) {
    const next = checkBound(value, 'min');
    if (next > this._max) {
      throw new RangeError(`PowerServo: min (${next}) must be <= max (${this._max})`);
    }
    this._min = next;
  }

  /**
   * Upper output bound. `Infinity` for no upper bound.
   *
   * @type {number}
   */
  get max() {
    return this._max;
  }

  set max(value) {
    const next = checkBound(value, 'max');
    if (next < this._min) {
      throw new RangeError(`PowerServo: max (${next}) must be >= min (${this._min})`);
    }
    this._max = next;
  }

  /**
   * Advance the loop by one sample and return the control output.
   *
   * Three positional arguments rather than an options object because this is
   * called on a tick: a literal `{ dt, disturbance }` would allocate on every
   * step, and the whole point of a control helper is that it is cheap enough to
   * leave in a hot path.
   *
   * @param {number} measured - The process variable `y`. Must be finite.
   * @param {number} [dt] - Elapsed time since the last step, **in the same unit
   *   as the gains**. Defaults to the constructor's `dt`, which is `1`.
   * @param {number} [disturbance=0] - A known input the output must react to
   *   *before* the error moves. This is the feedforward path's argument.
   * @returns {number} The control output `u`, clamped to `[min, max]`.
   */
  step(measured, dt, disturbance = 0) {
    if (!Number.isFinite(measured)) {
      // A NaN or Infinity measurement is not a hard measurement; every term
      // downstream of it would be NaN, the bounds clamp would not catch NaN
      // (it is never `<` or `>` anything), and the integrator would poison
      // itself permanently. Refusing is the only recovery that leaves the
      // controller usable.
      throw new TypeError(`PowerServo: measured must be a finite number, got ${measured}`);
    }

    const h = dt === undefined ? this._defaultDt : Math.max(0, finite(dt, 0));
    const error = this.setpoint - measured;

    // **Derivative on the measurement, not the error.** `setpoint` therefore
    // does not appear in this term at all, which is the entire reason for the
    // choice: a setpoint step is an input transient the plant does not feel, and
    // differentiating it produces a spike proportional to how big the step was.
    let rawDerivative = 0;
    if (this._kd !== 0) {
      // **No previous measurement, or no positive `h`: there is no slope, and
      // both are handled identically.** The second case was a separate defect
      // from the first and was found by probing rather than by reading, because
      // it needs `h` to be 0 at the same moment as a `kd`:
      //
      // The fallback used to be `span = h === 0 ? this._defaultDt : h`, which
      // fabricates a tick length that did not happen. Two failures, one line:
      //
      // - `dt: 0` is an accepted option, so `_defaultDt` is 0, the fallback is
      //   0, and the slope divides by zero. Measured: `derivative` went to
      //   `-Infinity` on the second sample and to `NaN` on the third, and stayed
      //   NaN for 1000 further steps. `clamp` cannot catch NaN, so nothing in the
      //   loop recovered it — the same unrecoverable state the accessors above
      //   were added to close, reached through an option rather than a field.
      // - With a nonzero default and a per-step `dt` of 0 it stays finite and is
      //   therefore quieter still: a 50-unit move over a 0.001 default reported
      //   a slope of -50000, a number the loop then carried into its output.
      //
      // Holding the derivative is also what the integral already does at `h === 0`
      // — it accumulates nothing, because no time passed. The two terms must not
      // disagree about whether time passed; that disagreement is what made this
      // asymmetric, and it is invisible in the output until the slope is large.
      if (this._previousMeasured !== null && h > 0) {
        rawDerivative = (this._previousMeasured - measured) / h;
      }
      // With no slope to compute, the derivative is left at its current value
      // rather than zeroed: zeroing it would make the output step once at the
      // start of every run and once after every zero-length step, which is a
      // transient the caller did not ask for.
      this._derivative =
        this._derivativeFilter === 0
          ? rawDerivative
          : this._derivative + this._derivativeFilter * (rawDerivative - this._derivative);
    }
    this._previousMeasured = measured;

    const feedback = this._kp * error + this._ki * this._integral + this._kd * this._derivative;

    let ff = 0;
    if (typeof this._feedforward === 'function') {
      const contribution = this._feedforward({
        measured,
        setpoint: this.setpoint,
        disturbance,
        output: this._output,
      });
      // A feedforward function that returns a non-number is a caller bug that
      // would otherwise become a NaN that no comparison can catch.
      if (typeof contribution !== 'number' || !Number.isFinite(contribution)) {
        throw new TypeError(
          `PowerServo: feedforward returned ${contribution}, expected a finite number`
        );
      }
      ff = contribution;
    } else if (this._feedforwardGain !== 0) {
      ff = this._feedforwardGain * disturbance;
    }

    const unclamped = ff + feedback;
    const output = clamp(unclamped, this.min, this.max);

    // **Anti-windup by clamping the integral to the output bounds.** The
    // integral may only push the output *inside* `[min, max]`; anything beyond
    // that is a number the output cannot use, so accumulating it is the windup
    // bug in its purest form.
    //
    // Two weaker mechanisms were implemented and measured first, and the
    // measurement is why this one won:
    //
    // - **Back-calculation**, the textbook choice, feeds the clipped amount back
    //   into the integrator at `1 / Tt`. It parks the integral at the fixed
    //   point `I = (max − kp·e + e·ki/Kb) / ki` — for `kp: 0.5, ki: 2,
    //   Kb: 0.5, e: 100, max: 8` that is **+179**, against the **−21** that
    //   clamping holds. It cannot do better without a gain large enough to break
    //   the recursion, whose stability condition (`Kb · dt < 2`) is a second way
    //   to be wrong, and it took **10** further steps after the obstruction
    //   cleared before the output came off `max`. Clamping releases in **one**.
    //   Its sign is also easy to invert: `saturationError` is
    //   `unclamped − output`, positive when clipped from above, so adding a
    //   multiple of it grows the integral *further into* the clip. Measured with
    //   the sign the other way round: 3.96e+152 after 500 steps, and no return.
    // - **Conditional integration** — freeze the integral while saturated and the
    //   error points outward. That is the same rule as clamping with the clamp
    //   left off, so it inherits clamping's stability and none of its exactness.
    //
    // Clamping needs no gain and no `dt` condition, which is the whole argument:
    // an anti-windup mechanism with a stability condition is a second controller
    // to tune.
    //
    // **Note this clamps the *contribution*, not the stored integral**, which is
    // what makes it correct for a negative `ki` as well: a reverse-acting
    // controller has `lo > hi` in integral space, and clamping the contribution
    // gets that right without a second branch. Measured: `ki: -2` settles at a
    // bounded `integral` of 25 with the output inside its bounds, where clamping
    // the integral itself would have inverted the window.
    if (this._ki !== 0) {
      this._integral += error * h;
      // The window the integral's *contribution* may occupy. It is offset by the
      // feedforward term and the proportional term because those are already
      // spoken for: `u = ff + kp·e + ki·I`, so `ki·I` has what is left over.
      // With a feedforward function that is not affine in `d` the clamp is
      // conservative rather than exact, which is the safe direction.
      const contribution = this._ki * this._integral;
      const lo = this.min - ff - this._kp * error;
      const hi = this.max - ff - this._kp * error;
      if (contribution < lo) this._integral = divideOrZero(lo, this._ki);
      else if (contribution > hi) this._integral = divideOrZero(hi, this._ki);
    }

    this._output = output;
    this._error = error;
    // "Up against a bound", not "arithmetic clipped this tick". Those differ now
    // that the integral is clamped: the pin leaves `unclamped` sitting exactly on
    // `max`, so a clip-detector goes false on the tick after the first and
    // reports a healthy loop that is in fact pinned. Which bound the output is
    // resting against is the question a caller can act on.
    this._saturated = output === this.min || output === this.max;
    return output;
  }

  /**
   * The control output from the last {@link PowerServo#step}.
   *
   * Reported rather than relied on: `step()` returns it too. This exists so a
   * caller wiring the output into something on a *different* tick — a field
   * read, a stats block — does not have to keep its own copy of a number it
   * computed.
   *
   * @returns {number}
   */
  get output() {
    return this._output;
  }

  /**
   * The error from the last step, `setpoint - measured`.
   *
   * @returns {number}
   */
  get error() {
    return this._error;
  }

  /**
   * The accumulated integral term, in error·time units. Exposed because a
   * controller whose integral keeps climbing while the output sits still at a
   * bound is the windup bug, and it is otherwise invisible.
   *
   * @returns {number}
   */
  get integral() {
    return this._integral;
  }

  /**
   * The filtered derivative term from the last step, per unit time.
   *
   * @returns {number}
   */
  get derivative() {
    return this._derivative;
  }

  /**
   * Whether the last step was clamped by `min` or `max`.
   *
   * @returns {boolean}
   */
  get saturated() {
    return this._saturated;
  }

  /**
   * Restore the controller to its constructed state: no accumulated integral, no
   * remembered measurement, no output.
   *
   * Bounds, gains and setpoint are configuration and survive, because a caller
   * resetting a loop between workloads wants the tuning they already chose.
   *
   * @returns {void}
   */
  reset() {
    this._integral = 0;
    this._previousMeasured = null;
    this._derivative = 0;
    this._output = 0;
    this._error = 0;
    this._saturated = false;
  }

  /**
   * Release this instance's state.
   *
   * **A state reset, not a teardown.** This class owns no timer, no listener and
   * no `FinalizationRegistry` — `dt` is an argument, by design — so there is
   * nothing to cancel and nothing to unregister. It exists so a
   * `PowerServo` held for a process lifetime can take part in `using` /
   * `await using` or a DI teardown alongside every other long-lived helper here.
   *
   * The instance stays usable afterwards, deliberately: calling it a teardown
   * and then having `reset()` throw on a second call would document work that
   * does not happen.
   *
   * @returns {void}
   */
  dispose() {
    this.reset();
  }

  /**
   * Alias for {@link PowerServo#dispose}, so `using s = new PowerServo()`
   * releases the instance deterministically at scope exit.
   *
   * @returns {void}
   */
  [Symbol.dispose]() {
    this.dispose();
  }
}

/**
 * Divide for the integral clamp, falling back to `0` when the quotient
 * overflows.
 *
 * The clamp solves `ki·I = bound` for `I`, and a denormal `ki` makes that
 * quotient an infinity — at which point the stored integral is `±Infinity`, and
 * `ki · ±Infinity` on the next step is `NaN`, which is the unrecoverable state
 * this whole accessor-and-guard pass exists to remove. Measured with
 * `ki: 1e-320`: `integral` reached `-Infinity` within 50 steps.
 *
 * `0` is the only safe fallback, because `ki·0` is `0` for every `ki`, including
 * the degenerate one. The loop then behaves as a proportional-only controller
 * for one step, which is recoverable, rather than being permanently wrong.
 *
 * @param {number} numerator
 * @param {number} denominator
 * @returns {number}
 */
function divideOrZero(numerator, denominator) {
  const quotient = numerator / denominator;
  return Number.isFinite(quotient) ? quotient : 0;
}

/**
 * Validate one bound on assignment. `±Infinity` is allowed and means "unbounded
 * on this side"; `NaN` is not, and is the case that matters — a `NaN` bound
 * makes every comparison against it false, which silently removes the clamp
 * rather than failing loudly.
 *
 * @param {*} value
 * @param {string} name
 * @returns {number}
 */
function checkBound(value, name) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError(`PowerServo: ${name} must be a number, got ${value}`);
  }
  return value;
}

/**
 * Coerce to a finite number, falling back for `undefined`, `NaN` and
 * infinities. A gain of `Infinity` is not a gain; it is a typo, and letting it
 * through would make every subsequent product `Infinity` or `NaN` with no way
 * to tell which term did it.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * @param {number} value
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clampRange(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Resolve one output bound, treating `null`/`undefined` as "unbounded" in the
 * direction that makes sense for that side.
 *
 * @param {*} value
 * @param {number} fallback
 * @param {number} floor
 * @param {number} ceiling
 * @returns {number}
 */
function bound(value, fallback, floor, ceiling) {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) return fallback;
  // An explicit ±Infinity is how a caller says "unbounded on this side", so it
  // is honoured; anything else out of range is clamped into it.
  if (n === Infinity || n === -Infinity) return n;
  return Math.max(floor, Math.min(ceiling, n));
}

/**
 * @param {number} value
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(value, lo, hi) {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}
