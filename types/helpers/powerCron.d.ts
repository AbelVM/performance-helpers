/**
 * @typedef {'skip'|'catch-up'|'run-once'} CatchUpPolicy
 *
 * @typedef {Object} PowerCronOptions
 * @property {number} [intervalMs=60000] - Milliseconds between fires. Must be
 *   at least 10, so a typo cannot become a hot loop.
 * @property {CatchUpPolicy} [catchUp='skip'] - What to do about fires missed
 *   while the process was busy or asleep:
 *   - `'skip'` (default) run once, immediately, then resume the normal cadence.
 *   - `'catch-up'` replay every missed fire, in order, before resuming. Correct
 *     for jobs that must account for each period (billing, rollups).
 *   - `'run-once'` coalesce all missed fires into a single run.
 * @property {number} [jitter=0] - Random fraction (0–1) of the interval added
 *   to each fire, spreading a fleet's crons so they do not stampede a
 *   dependency on the same minute boundary.
 * @property {boolean} [runOnStart=false] - Fire once immediately on `start()`,
 *   then follow the normal cadence.
 * @property {(err:Error)=>void} [onError] - Called when the task throws or
 *   rejects. Errors are swallowed by default so one bad run does not kill the
 *   schedule.
 * @property {(info:Object)=>void} [onFire] - Called after each successful run
 *   with `{ scheduledFor, ranAt, driftMs, missed }`. **`missed` is the number of
 *   missed periods *this run* stands in for**, and it was always `0` before 2.0 —
 *   in the one payload a caller would use to see catch-up working. Under `catch-up`
 *   each replay reports `1` (it is that period being run) and the run that follows
 *   reports `0`, because the replays have already accounted for them. Under `skip`
 *   and `run-once` the single run reports how many periods were dropped or folded
 *   into it.
 * @property {boolean} [unref=true] - Whether the pending timer is `unref`'d, so
 *   a running cron does not by itself keep a Node process alive.
 */
/**
 * A drift-free cron-like scheduler built on `setTimeout` chaining.
 *
 * **Why not `setInterval`.** `setInterval` does not mean "every N ms". It means
 * "every N ms after the previous callback *returns*", so a run that takes longer
 * than the interval pushes every subsequent fire later, and the phase error
 * accumulates without bound — a job nominally on the minute drifts seconds per
 * hour and is no longer "on the minute" by the end of the day. Long callbacks
 * also queue up: a 1 s job on a 5 s interval that stalls for 30 s fires six
 * times in a row on resume.
 *
 * This scheduler re-arms from an absolute target instead. Each run records the
 * fire time it was *aimed at*, and the next timer is computed from that target
 * rather than from `Date.now()`. Drift therefore cannot accumulate: a run that
 * takes 800 ms of a 1 s interval still leaves the next fire 200 ms away, not
 * 800 ms away.
 *
 * Skipping a whole interval (`Math.floor(elapsed / interval) + 1`) is what keeps
 * a stalled run from immediately re-firing. What happens to the fires that were
 * missed in between is a policy decision, not a scheduling detail, so it is an
 * option — see {@link PowerCronOptions.catchUp}.
 *
 * @class PowerCron
 * @public
 * @example
 * const cron = new PowerCron(() => collectMetrics(), { intervalMs: 60_000 });
 * cron.start();
 * // later
 * cron.stop();
 */
export class PowerCron {
    /**
     * @param {() => any} task - The function to run on each fire. May be async;
     *   a rejected promise is routed to `onError` and does not stop the schedule.
     * @param {PowerCronOptions} [options]
     */
    constructor(task: () => any, options?: PowerCronOptions);
    _task: () => any;
    _intervalMs: number;
    _catchUp: "skip" | "catch-up" | "run-once";
    _jitter: number;
    _runOnStart: boolean;
    _onError: ((err: Error) => void) | null;
    _onFire: ((info: Object) => void) | null;
    _unref: boolean;
    /** @type {any} */
    _timer: any;
    _running: boolean;
    /** Absolute timestamp the next fire is aimed at. */
    _nextAt: number;
    /**
     * Times the task was invoked. Exposed as `fireCount` so a caller can count
     * runs rather than assume one per interval.
     *
     * **It counts catch-up replays, and it is not always the number of task
     * invocations.** `catchUp: 'catch-up'` increments it once per replay, so it
     * tracks invocations exactly. `catchUp: 'run-once'` adds the number of
     * *periods covered* rather than the single run that covered them, so there it
     * counts work done, not runs made — measured, blocking the loop to force a
     * six-period stall: `'skip'` 6 invocations / 6, `'catch-up'` 17 / 17,
     * `'run-once'` 6 / 17.
     *
     * A previous version of this comment said the opposite — that it did *not*
     * count replays, "and used to claim it did" — which was itself the error: the
     * replays are counted at the two `+=` sites below, and `guides/powerCron.md`
     * said so correctly while this said otherwise. What is genuinely not replayed
     * is a period missed while **stopped**: `start()` sets
     * `_nextAt = nowMs() + intervalMs`, so a restart begins a fresh cadence, which
     * is the right behaviour for a cron — replaying a backlog after a deploy would
     * stamp a dozen tasks at once.
     * @type {number}
     * @private
     */
    private _fireCount;
    /**
     * Accumulated scheduling error, in ms, between when a fire was due and when
     * it actually ran. Exposed so drift is measurable rather than folklore.
     * @type {number}
     * @private
     */
    private _totalDriftMs;
    /** @returns {number} The configured interval, in ms. */
    get intervalMs(): number;
    /** @returns {boolean} Whether the schedule is armed. */
    get running(): boolean;
    /** @returns {number} How many times the task has been invoked. */
    get fireCount(): number;
    /**
     * Mean drift in ms per fire — 0 when nothing has run yet. A schedule that
     * cannot keep up shows a growing mean, which is the signal to raise the
     * interval or shorten the task.
     * @returns {number}
     */
    get averageDriftMs(): number;
    /** @returns {number|null} Epoch ms the next fire is aimed at. */
    get nextRunAt(): number | null;
    /**
     * Arm the schedule. Idempotent.
     *
     * With `runOnStart`, the task fires immediately and the cadence is anchored
     * to that moment. Without it, the first fire is one interval from now — so a
     * cron started at 10:00:37 with a 60 s interval fires at 10:01:37, not
     * 10:01:00. Aligning to wall-clock boundaries is deliberately not done: a
     * shared "top of the minute" is the single largest source of thundering herd
     * in a fleet, and `jitter` exists for callers who want some of that back.
     *
     * @returns {this}
     */
    start(): this;
    /**
     * Disarm the schedule. Idempotent.
     *
     * A task already in flight is left to finish — cancelling it would mean
     * abandoning work that may hold resources, and there is no way to interrupt a
     * synchronous task anyway.
     *
     * @returns {this}
     */
    stop(): this;
    /**
     * Fire immediately, out of band, without disturbing the cadence.
     * @returns {this}
     */
    runNow(): this;
    /**
     * Arm a single timer for `_nextAt`.
     *
     * `unref` is applied when available: an unref'd timer does not hold the Node
     * event loop open, so a cron alone will not keep a process alive. A library
     * that silently does the opposite turns every "run this every minute" script
     * into something that needs `process.exit()`.
     *
     * @private
     * @returns {void}
     */
    private _arm;
    /**
     * The random component for this fire, in ms.
     * @private
     * @returns {number}
     */
    private _jitterDelay;
    /**
     * Handle a timer expiry: work out which periods were missed, apply the
     * catch-up policy, then re-arm from the absolute target.
     * @private
     * @returns {void}
     */
    private _onTimer;
    /**
     * Invoke the task, swallowing and reporting failures so a bad run cannot stop
     * the schedule.
     *
     * Errors are deliberately caught rather than allowed to escape: an unhandled
     * rejection from a timer callback takes the process down, so "one run threw"
     * would silently become "the cron is dead" or "the server is dead" depending
     * on the host.
     *
     * @private
     * @param {number} [scheduledFor] - The timestamp this run was aimed at.
     * @param {number} [missed=0] - How many missed periods **this run stands in
     *   for**, reported as `onFire`'s `missed`. RES-036: the field was hardcoded to `0`
     *   at both call sites, so a caller could not see catch-up working — which is the
     *   one thing that payload exists to show. The count was always known at the only
     *   place that matters: `_onTimer` had already computed it.
     * @returns {void}
     */
    private _run;
    /**
     * Route an error to `onError`, never letting it escape.
     * @private
     * @param {*} err
     * @param {string} where - Which callback threw, for the fallback log.
     * @returns {void}
     */
    private _report;
    /**
     * Stop the schedule for good.
     * @returns {void}
     */
    dispose(): void;
    /**
     * Alias for {@link PowerCron#dispose}, so `using cron = new PowerCron(...)`
     * stops the schedule at scope exit.
     * @returns {void}
     */
    [Symbol.dispose](): void;
}
export default PowerCron;
export type CatchUpPolicy = "skip" | "catch-up" | "run-once";
export type PowerCronOptions = {
    /**
     * - Milliseconds between fires. Must be
     * at least 10, so a typo cannot become a hot loop.
     */
    intervalMs?: number | undefined;
    /**
     * - What to do about fires missed
     * while the process was busy or asleep:
     * - `'skip'` (default) run once, immediately, then resume the normal cadence.
     * - `'catch-up'` replay every missed fire, in order, before resuming. Correct
     * for jobs that must account for each period (billing, rollups).
     * - `'run-once'` coalesce all missed fires into a single run.
     */
    catchUp?: CatchUpPolicy | undefined;
    /**
     * - Random fraction (0–1) of the interval added
     * to each fire, spreading a fleet's crons so they do not stampede a
     * dependency on the same minute boundary.
     */
    jitter?: number | undefined;
    /**
     * - Fire once immediately on `start()`,
     * then follow the normal cadence.
     */
    runOnStart?: boolean | undefined;
    /**
     * - Called when the task throws or
     * rejects. Errors are swallowed by default so one bad run does not kill the
     * schedule.
     */
    onError?: ((err: Error) => void) | undefined;
    /**
     * - Called after each successful run
     * with `{ scheduledFor, ranAt, driftMs, missed }`. **`missed` is the number of
     * missed periods *this run* stands in for**, and it was always `0` before 2.0 —
     * in the one payload a caller would use to see catch-up working. Under `catch-up`
     * each replay reports `1` (it is that period being run) and the run that follows
     * reports `0`, because the replays have already accounted for them. Under `skip`
     * and `run-once` the single run reports how many periods were dropped or folded
     * into it.
     */
    onFire?: ((info: Object) => void) | undefined;
    /**
     * - Whether the pending timer is `unref`'d, so
     * a running cron does not by itself keep a Node process alive.
     */
    unref?: boolean | undefined;
};
