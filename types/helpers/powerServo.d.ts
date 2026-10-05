export class PowerServo {
    /**
     * @typedef {import('./jsdoc-types.js').PowerServoOptions} PowerServoOptions
     */
    /**
     * @param {PowerServoOptions} [options]
     */
    constructor(options?: import("./jsdoc-types.js").PowerServoOptions);
    /** @type {number} */
    set setpoint(value: number);
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
    get setpoint(): number;
    /** @type {number} - Proportional gain. */
    /** @type {number} - Integral gain. Zero disables the integrator entirely. */
    /** @type {number} - Derivative gain. Zero disables the derivative path. */
    /**
     * First-order low-pass coefficient on the derivative term, in `[0, 1)`.
     * `0` filters nothing (raw differentiation); values near `1` make the
     * derivative very slow. Ignored when `kd` is `0`.
     */
    /** @type {Function|number|null} - Open-loop term, ahead of the error. */
    /**
     * Static-gain form of the feedforward path, applied to `disturbance` when
     * `feedforward` is not a function. Setting it implies
     * `feedforward: (d) => d * gain`.
     */
    /**
     * Default `dt` for {@link PowerServo#step}, in whatever time unit the gains
     * are expressed in. `1` makes a controller that ignores wall time behave
     * correctly for a fixed-rate tick, and callers on a real clock should pass
     * their own elapsed time instead.
     */
    set min(value: number);
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
    get min(): number;
    set max(value: number);
    /**
     * Upper output bound. `Infinity` for no upper bound.
     *
     * @type {number}
     */
    get max(): number;
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
    step(measured: number, dt?: number, disturbance?: number): number;
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
    get output(): number;
    /**
     * The error from the last step, `setpoint - measured`.
     *
     * @returns {number}
     */
    get error(): number;
    /**
     * The accumulated integral term, in error·time units. Exposed because a
     * controller whose integral keeps climbing while the output sits still at a
     * bound is the windup bug, and it is otherwise invisible.
     *
     * @returns {number}
     */
    get integral(): number;
    /**
     * The filtered derivative term from the last step, per unit time.
     *
     * @returns {number}
     */
    get derivative(): number;
    /**
     * Whether the last step was clamped by `min` or `max`.
     *
     * @returns {boolean}
     */
    get saturated(): boolean;
    /**
     * Restore the controller to its constructed state: no accumulated integral, no
     * remembered measurement, no output.
     *
     * Bounds, gains and setpoint are configuration and survive, because a caller
     * resetting a loop between workloads wants the tuning they already chose.
     *
     * @returns {void}
     */
    reset(): void;
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
    dispose(): void;
    /**
     * Alias for {@link PowerServo#dispose}, so `using s = new PowerServo()`
     * releases the instance deterministically at scope exit.
     *
     * @returns {void}
     */
    [Symbol.dispose](): void;
}
