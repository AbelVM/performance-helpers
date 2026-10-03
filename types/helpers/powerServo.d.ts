export class PowerServo {
    /**
     * @typedef {import('./jsdoc-types.js').PowerServoOptions} PowerServoOptions
     */
    /**
     * @param {PowerServoOptions} [options]
     */
    constructor(options?: import("./jsdoc-types.js").PowerServoOptions);
    /** @type {number} - The reference `r`. Readable and writable. */
    setpoint: number;
    /** @type {number} - Proportional gain. */
    _kp: number;
    /** @type {number} - Integral gain. Zero disables the integrator entirely. */
    _ki: number;
    /** @type {number} - Derivative gain. Zero disables the derivative path. */
    _kd: number;
    /**
     * First-order low-pass coefficient on the derivative term, in `[0, 1)`.
     * `0` filters nothing (raw differentiation); values near `1` make the
     * derivative very slow. Ignored when `kd` is `0`.
     */
    _derivativeFilter: number;
    /** @type {number} - Lower output bound. `-Infinity` for no lower bound. */
    min: number;
    /** @type {number} - Upper output bound. `Infinity` for no upper bound. */
    max: number;
    /** @type {Function|number|null} - Open-loop term, ahead of the error. */
    _feedforward: Function | number | null;
    /**
     * Static-gain form of the feedforward path, applied to `disturbance` when
     * `feedforward` is not a function. Setting it implies
     * `feedforward: (d) => d * gain`.
     */
    _feedforwardGain: number;
    /**
     * Default `dt` for {@link PowerServo#step}, in whatever time unit the gains
     * are expressed in. `1` makes a controller that ignores wall time behave
     * correctly for a fixed-rate tick, and callers on a real clock should pass
     * their own elapsed time instead.
     */
    _defaultDt: number;
    _integral: number;
    _previousMeasured: number | null;
    _derivative: number;
    _output: number;
    _error: number;
    _saturated: boolean;
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
