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
    constructor(options?: number | PowerFlowControlOptions);
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
    /**
     * The current adaptive refill rate, in tokens per second.
     * @returns {number}
     */
    get rate(): number;
    /**
     * Tokens currently available.
     * @returns {number}
     */
    get tokens(): number;
    /**
     * The bucket size.
     * @returns {number}
     */
    get capacity(): number;
    /**
     * The underlying controller, for a caller that wants to retune it at runtime.
     *
     * Exposed rather than wrapped because the gains are the caller's to set, and a
     * second set of accessors here would be a second place for them to drift.
     * @returns {PowerServo}
     */
    get servo(): PowerServo;
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
    observe(measured: number, dt?: number, disturbance?: number): number;
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
    /**
     * Try to consume `n` tokens.
     * @param {number} [n=1]
     * @returns {boolean} `true` when the tokens were available.
     */
    tryConsume(n?: number): boolean;
    /**
     * Add tokens directly, bypassing the rate.
     *
     * Exists for the same reason `PowerThrottle.addTokens` does: a test that has
     * to wait for a refill is a test that is slow and flaky in the same way.
     * @param {number} n
     * @returns {void}
     */
    addTokens(n: number): void;
    /**
     * Discard all state and resume from the configured initial rate.
     *
     * A state reset, not a teardown: this helper owns no timer and no clock, so
     * there is nothing to cancel. The interface exists so it can take part in
     * `using` / `await using` like every other long-lived helper here.
     * @returns {void}
     */
    reset(): void;
    /**
     * Alias for {@link PowerFlowControl#reset}.
     * @returns {void}
     */
    clear(): void;
    /**
     * @returns {void}
     */
    dispose(): void;
    /**
     * @returns {object} Counters. `rate` and `tokens` are live state;
     *   `observations` counts controller samples, which is the number to alert on
     *   — a loop that has stopped being fed is a loop whose rate has gone stale.
     */
    stats(): object;
    /**
     * Alias for {@link PowerFlowControl#stats}, matching the rest of the library.
     * @returns {object}
     */
    getStats(): object;
    [Symbol.dispose](): void;
    [Symbol.asyncDispose](): Promise<void>;
}
export default PowerFlowControl;
export type PowerFlowControlOptions = {
    /**
     * - Bucket size, in tokens. The burst a single
     * refill interval can admit.
     */
    capacity?: number | undefined;
    /**
     * - Refill rate the bucket starts at, in
     * tokens per second, before the first `observe()` moves it.
     */
    initialRate?: number | undefined;
    /**
     * - Lower bound on the adaptive rate. `0` means
     * the controller may close the bucket entirely.
     */
    minRate?: number | undefined;
    /**
     * - Upper bound on the adaptive rate.
     * Required in practice: an unbounded controller output is not a limit.
     */
    maxRate?: number | undefined;
    /**
     * - The value `observe()` should hold. Forwarded
     * to the servo.
     */
    setpoint?: number | undefined;
    /**
     * - Proportional gain. Forwarded to the servo.
     */
    kp?: number | undefined;
    /**
     * - Integral gain. Forwarded to the servo.
     */
    ki?: number | undefined;
    /**
     * - Derivative gain. Forwarded to the servo.
     */
    kd?: number | undefined;
    /**
     * - Forwarded to the servo.
     */
    derivativeFilter?: number | undefined;
    /**
     * - Default sample interval, forwarded to the servo.
     */
    dt?: number | undefined;
    /**
     * - Called
     * when the adaptive rate moves. The hook a caller uses to push the rate into
     * a pool's concurrency setting.
     */
    onRateChange?: ((rate: number, previous: number) => void) | undefined;
    /**
     * - Injected clock, as the limiters take
     * (PERF-007). Defaults to `Date.now`.
     */
    now?: (() => number) | undefined;
    /**
     * -
     * Opt in to metrics. See `guides/metrics.md`.
     */
    observability?: boolean | import("./metrics.js").MetricsCollector | undefined;
};
import { PowerServo } from './powerServo.js';
