import { MS_PER_MIN } from './constants.js';
import { nowMs } from '../utils/now.js';
import { isError } from '../utils/errors.js';
import { assertFunction, assertLimitRequired, assertKnownOptions } from '../utils/options.js';

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
 * @property {number} [maxCatchUp=Infinity] - Cap on how many missed periods
 *   `'catch-up'` replays in one timer tick. **`Infinity` is the default and the
 *   opt-out** — see the note below on why a default is not a floor. A finite
 *   value stops a backlog from becoming a synchronous burst: measured, a cron
 *   that fell ~600 periods behind on a 10 ms interval replayed all 600 in one
 *   tick, which extrapolates to ~8.6 M invocations for 24 h of drift.
 * @property {boolean} [overlap=false] - Whether a task may run again before the
 *   previous one finished. **Off by default**, because a cron is a schedule, not
 *   a fan-out: measured, a 50 ms task on a 20 ms interval fired 15 times with 15
 *   concurrent runs. With it on, the cadence is what drives the timer and the
 *   task is fire-and-forget; with it off, a run still in flight blocks the next
 *   fire and the blocked periods are reported as missed by the following tick.
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
  constructor(task, options = {}) {
    assertKnownOptions(
      options,
      [
        'intervalMs',
        'maxCatchUp',
        'overlap',
        'catchUp',
        'jitter',
        'runOnStart',
        'onError',
        'onFire',
        'unref',
      ],
      'PowerCron'
    );
    assertFunction(task, { name: 'task', className: 'PowerCron', optional: false });

    this._task = task;
    this._intervalMs = assertLimitRequired(options.intervalMs, {
      name: 'intervalMs',
      className: 'PowerCron',
      min: 10,
      fallback: MS_PER_MIN,
    });
    // `Infinity` is the default and the opt-out: a cron that fell behind is
    // supposed to replay, and capping it is the whole point of the option.
    // Measured before this existed — a 10 ms cron that fell ~600 periods
    // behind replayed all 600 in one synchronous tick.
    this._maxCatchUp = assertLimitRequired(options.maxCatchUp, {
      name: 'maxCatchUp',
      className: 'PowerCron',
      min: 0,
      allowInfinity: true,
      fallback: Infinity,
    });
    this._overlap = Boolean(options.overlap);
    const catchUp = options.catchUp;
    this._catchUp =
      catchUp === 'catch-up' || catchUp === 'run-once' || catchUp === 'skip' ? catchUp : 'skip';
    const jitter = Number(options.jitter);
    this._jitter = Number.isFinite(jitter) ? Math.min(1, Math.max(0, jitter)) : 0;
    this._runOnStart = Boolean(options.runOnStart);
    this._onError = typeof options.onError === 'function' ? options.onError : null;
    this._onFire = typeof options.onFire === 'function' ? options.onFire : null;
    this._unref = options.unref !== false;

    /** @type {any} */
    this._timer = null;
    this._running = false;
    /** Absolute timestamp the next fire is aimed at. */
    this._nextAt = 0;
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
    this._fireCount = 0;
    /**
     * Accumulated scheduling error, in ms, between when a fire was due and when
     * it actually ran. Exposed so drift is measurable rather than folklore.
     * @type {number}
     * @private
     */
    this._totalDriftMs = 0;
    /**
     * Whether a task is currently in flight. `overlap` gates the schedule on
     * it: with it off, a tick whose target arrives while a task is running is
     * dropped rather than stacking two tasks. Nothing else reads this — it is
     * the only state the overlap policy needs.
     * @type {boolean}
     * @private
     */
    this._runningTask = false;
  }

  /** @returns {number} The configured interval, in ms. */
  get intervalMs() {
    return this._intervalMs;
  }

  /** @returns {boolean} Whether the schedule is armed. */
  get running() {
    return this._running;
  }

  /** @returns {number} How many times the task has been invoked. */
  get fireCount() {
    return this._fireCount;
  }

  /**
   * Mean drift in ms per fire — 0 when nothing has run yet. A schedule that
   * cannot keep up shows a growing mean, which is the signal to raise the
   * interval or shorten the task.
   * @returns {number}
   */
  get averageDriftMs() {
    return this._fireCount ? this._totalDriftMs / this._fireCount : 0;
  }

  /** @returns {number|null} Epoch ms the next fire is aimed at. */
  get nextRunAt() {
    return this._running ? this._nextAt : null;
  }

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
  start() {
    if (this._running) return this;
    this._running = true;
    this._nextAt = nowMs() + this._intervalMs;
    // Arm first, then optionally run immediately. Arming first means
    // `runOnStart` cannot forget to schedule: an earlier version ran the task
    // and returned without arming, so a `runOnStart` cron fired exactly once
    // and then went silent. A test that asserted "fires immediately, then
    // follows the cadence" caught it.
    this._arm();
    if (this._runOnStart) {
      this._fireCount += 1;
      this._run();
    }
    return this;
  }

  /**
   * Disarm the schedule. Idempotent.
   *
   * A task already in flight is left to finish — cancelling it would mean
   * abandoning work that may hold resources, and there is no way to interrupt a
   * synchronous task anyway.
   *
   * @returns {this}
   */
  stop() {
    this._running = false;
    this._runningTask = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    return this;
  }

  /**
   * Fire immediately, out of band, without disturbing the cadence.
   * @returns {this}
   */
  runNow() {
    this._fireCount += 1;
    this._run();
    return this;
  }

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
  _arm() {
    if (!this._running) return;
    const delay = Math.max(0, this._nextAt - nowMs()) + this._jitterDelay();
    this._timer = setTimeout(() => {
      this._timer = null;
      this._onTimer();
    }, delay);
    if (this._unref && typeof this._timer?.unref === 'function') this._timer.unref();
  }

  /**
   * The random component for this fire, in ms.
   * @private
   * @returns {number}
   */
  _jitterDelay() {
    return this._jitter > 0 ? Math.random() * this._jitter * this._intervalMs : 0;
  }

  /**
   * Handle a timer expiry: work out which periods were missed, apply the
   * catch-up policy, then re-arm from the absolute target.
   * @private
   * @returns {void}
   */
  _onTimer() {
    if (!this._running) return;
    const now = nowMs();
    const target = this._nextAt;
    // How many whole intervals have elapsed since the last aimed-at time? At
    // least 1, because this timer is for `target` itself. This is the count of
    // *missed* fires beyond the one being handled now.
    const missedPeriods = Math.max(0, Math.floor((now - target) / this._intervalMs));

    // **Overlap is a property of the schedule, not of the task.** With it off
    // (the default) a run still in flight blocks the next fire: this is a
    // schedule, not a fan-out, and two tasks running at once is the thing the
    // option exists to prevent. Measured before it existed — a 50 ms task on a
    // 20 ms interval fired 15 times with 15 concurrent runs. The tick is
    // dropped, the target advances past it, and the next one fires on time, so
    // the cadence is what drives the timer and the dropped period is reported
    // as missed by whatever run follows. `runNow()` is out of band and not
    // gated: a caller who asks for it explicitly owns the concurrency.
    if (!this._overlap && this._runningTask) {
      this._nextAt = target + (missedPeriods + 1) * this._intervalMs;
      this._arm();
      return;
    }

    // **`maxCatchUp` caps the replay, and the cap is the whole point.** Measured
    // before this option existed: a 10 ms cron that fell ~600 periods behind
    // replayed all 600 in one synchronous tick, which extrapolates to ~8.6 M
    // invocations for 24 h of drift. The periods the cap refuses are not
    // replayed and are not silently dropped — the run that follows stands in
    // for them, so `missed` still says how many there were.
    const replayed = this._catchUp === 'catch-up' ? Math.min(missedPeriods, this._maxCatchUp) : 0;
    const dropped = missedPeriods - replayed;

    if (this._catchUp === 'catch-up') {
      // Replay every missed period, oldest first, then this one. Each replay is
      // counted so `fireCount` reflects the work actually done.
      for (let i = 0; i < replayed; i += 1) {
        this._fireCount += 1;
        // Each replay stands in for exactly one missed period - it *is* that
        // period being run - so it reports `missed: 1` rather than `0`.
        this._run(target + i * this._intervalMs, 1);
      }
    } else if (this._catchUp === 'run-once' && missedPeriods > 0) {
      // Coalesce: one run stands in for all of them.
      this._fireCount += missedPeriods;
    }

    this._fireCount += 1;
    // Under `catch-up` the replays above have already accounted for every
    // missed period they replayed, so this run stands in for the ones the cap
    // refused — which under `Infinity` is every missed period, the old
    // behaviour. Under `skip` they were dropped and under `run-once` they
    // were folded into this run; either way the number the caller needs is
    // how many there were, which is what `_onTimer` already knows.
    this._run(target, this._catchUp === 'catch-up' ? dropped : missedPeriods);

    // Advance the target by whole intervals, never from `now`. Anchoring here
    // rather than at the run is what makes the schedule drift-free.
    this._nextAt = target + (missedPeriods + 1) * this._intervalMs;
    this._arm();
  }

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
  _run(scheduledFor = nowMs(), missed = 0) {
    const ranAt = nowMs();
    const driftMs = Math.max(0, ranAt - scheduledFor);
    this._totalDriftMs += driftMs;
    this._runningTask = true;
    const finish = () => {
      this._runningTask = false;
    };
    /** @type {any} Declared here so `finally` can tell the two paths apart. */
    let result;
    try {
      result = this._task();
      if (result && typeof result.then === 'function') {
        result
          .then(
            () => {
              if (this._onFire) {
                try {
                  this._onFire({ scheduledFor, ranAt, driftMs, missed });
                } catch (e) {
                  this._report(e, 'onFire');
                }
              }
            },
            (/** @type {any} */ err) => this._report(err, 'task')
          )
          .then(finish, finish);
      } else if (this._onFire) {
        try {
          this._onFire({ scheduledFor, ranAt, driftMs, missed });
        } catch (e) {
          this._report(e, 'onFire');
        }
      }
    } catch (err) {
      this._report(err, 'task');
    } finally {
      // A synchronous task — including one that threw — is done now, so the
      // flag clears before the next tick can read it. An async task clears in
      // the `.then(finish, finish)` above; calling `finish` there too rather
      // than in `finally` is what keeps the two paths from racing, because a
      // `finally` runs before the promise settles.
      if (!result || typeof result.then !== 'function') finish();
    }
  }

  /**
   * Route an error to `onError`, never letting it escape.
   * @private
   * @param {*} err
   * @param {string} where - Which callback threw, for the fallback log.
   * @returns {void}
   */
  _report(err, where) {
    if (this._onError) {
      try {
        // `isError()` rather than `instanceof Error`. A cross-realm `err` failed
        // `instanceof` and was **replaced** by `new Error(String(err))`, which
        // stringifies to `"TypeError: …"` and discards the caller's `code` and
        // stack — so `onError` was told the cron entry failed rather than why.
        // WRK-007, and the same substitution `powerBulkhead` was fixed for.
        this._onError(isError(err) ? err : new Error(String(err)));
        return;
      } catch (e) {
        // A throwing onError must not become an unhandled rejection of its own.
        if (typeof console !== 'undefined') console.error(e);
        return;
      }
    }
    if (typeof console !== 'undefined') {
      console.error(`PowerCron ${where} threw and no onError is configured:`, err);
    }
  }

  /**
   * Stop the schedule for good.
   * @returns {void}
   */
  dispose() {
    this.stop();
  }

  /**
   * Alias for {@link PowerCron#dispose}, so `using cron = new PowerCron(...)`
   * stops the schedule at scope exit.
   * @returns {void}
   */
  [Symbol.dispose]() {
    this.dispose();
  }
}

export default PowerCron;
