import { MS_PER_MIN } from './constants.js';
import { nowMs } from '../utils/now.js';
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
 * @property {number} [jitter=0] - Random fraction (0–1) of the interval added
 *   to each fire, spreading a fleet's crons so they do not stampede a
 *   dependency on the same minute boundary.
 * @property {boolean} [runOnStart=false] - Fire once immediately on `start()`,
 *   then follow the normal cadence.
 * @property {(err:Error)=>void} [onError] - Called when the task throws or
 *   rejects. Errors are swallowed by default so one bad run does not kill the
 *   schedule.
 * @property {(info:Object)=>void} [onFire] - Called after each successful run
 *   with `{ scheduledFor, ranAt, driftMs, missed }`.
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
      ['intervalMs', 'catchUp', 'jitter', 'runOnStart', 'onError', 'onFire', 'unref'],
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
     * It does **not** count catch-up replays, and used to claim it did. `start()`
     * sets `_nextAt = nowMs() + intervalMs`, so a restart begins a fresh cadence
     * and periods missed while stopped are not replayed — which is the right
     * behaviour for a cron, since replaying a backlog after a deploy would stamp
     * a dozen tasks at once. `'catch-up'` delays *within* a run, but nothing
     * revives periods missed while stopped.
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

    if (this._catchUp === 'catch-up') {
      // Replay every missed period, oldest first, then this one. Each replay is
      // counted so `fireCount` reflects the work actually done.
      for (let i = 0; i < missedPeriods; i += 1) {
        this._fireCount += 1;
        this._run(target + i * this._intervalMs);
      }
    } else if (this._catchUp === 'run-once' && missedPeriods > 0) {
      // Coalesce: one run stands in for all of them.
      this._fireCount += missedPeriods;
    }

    this._fireCount += 1;
    this._run(target);

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
   * @returns {void}
   */
  _run(scheduledFor = nowMs()) {
    const ranAt = nowMs();
    const driftMs = Math.max(0, ranAt - scheduledFor);
    this._totalDriftMs += driftMs;
    try {
      const result = this._task();
      if (result && typeof result.then === 'function') {
        result.then(
          () => {
            if (this._onFire) {
              try {
                this._onFire({ scheduledFor, ranAt, driftMs, missed: 0 });
              } catch (e) {
                this._report(e, 'onFire');
              }
            }
          },
          (/** @type {any} */ err) => this._report(err, 'task')
        );
      } else if (this._onFire) {
        try {
          this._onFire({ scheduledFor, ranAt, driftMs, missed: 0 });
        } catch (e) {
          this._report(e, 'onFire');
        }
      }
    } catch (err) {
      this._report(err, 'task');
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
        this._onError(err instanceof Error ? err : new Error(String(err)));
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
