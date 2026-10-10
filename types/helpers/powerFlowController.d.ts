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
    constructor(options?: PowerFlowControllerOptions);
    /** @type {() => number} */
    /** @type {number} */
    /**
     * The configured starting rate, kept separately from `_rate` because
     * `reset()` has to restore *this* and not `minRate` — a reset means "forget
     * what you learned", and the configured rate is the caller's own statement
     * about what the workload should get.
     * @type {number}
     */
    /** @type {number} */
    /** @type {number} */
    /** @type {number} */
    /** @type {number} */
    /** @type {number} */
    /** @type {boolean} */
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
    /** The injected clock, exposed so a caller can time work with the same one. */
    get now(): () => number;
    /** The rate the loop is currently admitting at, in operations per second. */
    get rate(): number;
    /** Lower bound on the adaptive rate. Always greater than 0. */
    get minRate(): number;
    /** Upper bound on the adaptive rate. */
    get maxRate(): number;
    /** The latency setpoint, in milliseconds. */
    get targetP99(): number;
    /** Items waiting to be admitted. */
    get depth(): number;
    /** Bound on the waiting queue. */
    get queueCapacity(): number;
    /**
     * Items `submit()` refused because the queue was full.
     *
     * **This is the number to alert on.** A flow controller that is dropping is a
     * flow controller whose rate is too low for the offered load, and nothing else
     * in `stats()` says so — the queue is bounded by design, so a healthy-looking
     * depth is exactly what overload looks like.
     */
    get dropped(): number;
    /**
     * The p99 of the **current, partial window** — the samples recorded since the
     * last `observe()`. `undefined` when the window is empty.
     *
     * Not a lifetime figure, and deliberately not: see the module docblock on why
     * a cumulative window makes the loop unable to recover.
     */
    get p99(): number | undefined;
    /** The underlying `PowerGCRA`, for `retryAfter()` and direct inspection. */
    get limiter(): PowerGCRA;
    /** The underlying `PowerServo`, for runtime retuning of the gains. */
    get servo(): PowerServo;
    /** The underlying `PowerHistogram`, for `snapshot()` and `toJSON()`. */
    get latency(): PowerHistogram;
    /** The underlying `PowerQueue`. */
    get queue(): PowerQueue;
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
    submit(item: any): boolean;
    /**
     * Take the next item, if the rate limiter admits one.
     *
     * @returns {any} The item, or `null` when the queue is empty or the GCRA
     *   refuses. `null` is not an error — refusing is what a rate limiter is for.
     */
    admit(): any;
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
    record(ms: number): void;
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
    observe(dt?: number): number;
    /**
     * Current state, as counters.
     *
     * @returns {{rate:number, minRate:number, maxRate:number, targetP99:number, quantile:number, depth:number, queueCapacity:number, submitted:number, admitted:number, recorded:number, dropped:number, observations:number, p99:number|undefined, saturated:boolean}}
     */
    stats(): {
        rate: number;
        minRate: number;
        maxRate: number;
        targetP99: number;
        quantile: number;
        depth: number;
        queueCapacity: number;
        submitted: number;
        admitted: number;
        recorded: number;
        dropped: number;
        observations: number;
        p99: number | undefined;
        saturated: boolean;
    };
    /**
     * Alias for {@link PowerFlowController#stats}.
     *
     * @returns {ReturnType<PowerFlowController['stats']>}
     */
    getStats(): ReturnType<PowerFlowController["stats"]>;
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
    reset(): void;
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
    clear(): void;
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
    dispose(): void;
    /**
     * Alias for {@link PowerFlowController#dispose}, so `using x = new X()`
     * releases the instance deterministically at scope exit.
     *
     * @returns {void}
     */
    [Symbol.dispose](): void;
    /**
     * Alias for {@link PowerFlowController#dispose}, for `await using`.
     *
     * @returns {void}
     */
    [Symbol.asyncDispose](): void;
}
export default PowerFlowController;
export type PowerFlowControllerOptions = {
    /**
     * - Initial sustained rate, in operations per second.
     * Required: a controller with no starting rate has nothing to clamp.
     */
    rate: number;
    /**
     * - GCRA burst tolerance, in operations. How many
     * may run back-to-back before the sustained rate applies.
     */
    burst?: number | undefined;
    /**
     * - Lower bound on the adaptive rate. **Must be
     * greater than 0.** The actuator is a GCRA, whose rate must be finite and
     * positive, so "admit nothing" is not a rate this controller can represent — a
     * caller who wants to stop admitting should stop calling `admit()`.
     */
    minRate: number;
    /**
     * - Upper bound on the adaptive rate.
     * Required in practice: an unbounded controller output is not a limit.
     */
    maxRate?: number | undefined;
    /**
     * - The latency setpoint, in milliseconds. The
     * servo drives the p99 toward this.
     */
    targetP99?: number | undefined;
    /**
     * - Which quantile of the window drives the
     * loop. `0.99` is the p99; `0.5` would make it a median controller.
     */
    quantile?: number | undefined;
    /**
     * - Bound on the waiting queue. `submit()`
     * returns `false` and increments `dropped` when it is full.
     */
    queueCapacity?: number | undefined;
    /**
     * - Proportional gain, in (operations per second)
     * per millisecond of latency error.
     */
    kp?: number | undefined;
    /**
     * - Integral gain. **Non-zero by default, and it
     * has to be.** With `ki: 0` the output is `kp × error` alone, so a window that
     * meets its target exactly produces an error of zero and therefore a rate of
     * zero — which the `minRate` clamp turns into the floor. Measured: P-only
     * settled at 11% of the rate the plant could sustain at the target latency.
     * The integrator is what holds the rate up when there is no error left to
     * correct.
     */
    ki?: number | undefined;
    /**
     * - Derivative gain, on the measurement. Off by
     * default: a p99 over a short window is noisy, and differentiating noise is
     * how a loop starts to oscillate.
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
     * - Forwarded to the histogram.
     */
    relativeAccuracy?: number | undefined;
    /**
     * - Called
     * when the rate moves. The hook for pushing the rate into a pool's concurrency
     * setting.
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
import { PowerGCRA } from './powerGCRA.js';
import { PowerQueue } from './powerQueue.js';
import { PowerHistogram } from './powerHistogram.js';
import { PowerServo } from './powerServo.js';
