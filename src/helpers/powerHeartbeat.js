import { assertKnownOptions, assertLimitRequired } from '../utils/options.js';

/**
 * PowerHeartbeat
 *
 * Liveness detector for a peer that is expected to check in on a schedule.
 * The helper owns the timer: it schedules a check at `interval` (plus jitter)
 * and declares the peer dead when no `beat()` has arrived within `timeout`.
 *
 * The jitter is the reason this exists rather than a bare `setInterval`. A
 * fleet of peers that all start from the same clock fires in lockstep, so the
 * timeout checks - and any reconnect storm that follows a shared failure -
 * arrive as one spike instead of a spread. Jittering the *scheduled* interval
 * by a fraction of itself decorrelates them without changing the mean rate.
 *
 * @class PowerHeartbeat
 * @public
 */
export class PowerHeartbeat {
  /**
   * @typedef {import('./jsdoc-types.js').PowerHeartbeatOptions} PowerHeartbeatOptions
   */
  /**
   * @param {number | PowerHeartbeatOptions} [options]
   */
  constructor(options = {}) {
    /** @type {PowerHeartbeatOptions} */
    let opts = /** @type {any} */ (options);
    if (typeof options === 'number') {
      opts = { interval: options };
    }
    assertKnownOptions(
      opts,
      ['interval', 'jitter', 'timeout', 'onTimeout', 'onBeat', 'now'],
      'PowerHeartbeat'
    );
    const interval = assertLimitRequired(opts.interval, {
      name: 'interval',
      className: 'PowerHeartbeat',
      min: 1,
      fallback: 30000,
    });
    const jitter = assertLimitRequired(opts.jitter, {
      name: 'jitter',
      className: 'PowerHeartbeat',
      min: 0,
      fallback: 0,
    });
    const timeout =
      opts.timeout !== undefined
        ? assertLimitRequired(opts.timeout, {
            name: 'timeout',
            className: 'PowerHeartbeat',
            min: 1,
            fallback: interval * 2,
          })
        : interval * 2;
    if (jitter > 1) {
      throw new TypeError(
        'PowerHeartbeat: `jitter` must be a fraction of the interval in 0..1 ' +
          `(received ${jitter}). A value above 1 would schedule the next check in the ` +
          'past, so the timer would fire immediately and the jitter would invert into ' +
          'a busy loop.'
      );
    }
    this._interval = interval;
    this._jitter = jitter;
    this._timeout = timeout;
    this._onTimeout = typeof opts.onTimeout === 'function' ? opts.onTimeout : null;
    this._onBeat = typeof opts.onBeat === 'function' ? opts.onBeat : null;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._timer = null;
    this._running = false;
    this._disposed = false;
    this._lastBeatAt = 0;
    this._missedBeats = 0;
    this._timedOut = false;
  }

  /**
   * Begin scheduling liveness checks. Idempotent: a second `start()` on a
   * running heartbeat does not reset the schedule, because the caller that
   * re-enters `start()` after a reconnect would otherwise silently postpone
   * the deadline it is trying to enforce.
   * @returns {void}
   */
  start() {
    if (this._disposed || this._running) return;
    this._running = true;
    this._timedOut = false;
    this._schedule();
  }

  /**
   * Stop scheduling checks. The recorded state (`missedBeats`, `lastBeatAt`)
   * survives, so a `stop()`/`start()` pair resumes the same deadline rather
   * than granting the peer a fresh one.
   * @returns {void}
   */
  stop() {
    this._running = false;
    this._clearTimer();
  }

  /**
   * Record that the peer is alive. Resets the missed-beat counter and the
   * deadline, and fires `onBeat` when one was configured.
   * @returns {void}
   */
  beat() {
    if (this._disposed) return;
    this._lastBeatAt = this._now();
    this._missedBeats = 0;
    this._timedOut = false;
    if (this._onBeat) this._onBeat(this._lastBeatAt);
  }

  /**
   * Register the timeout callback after construction.
   *
   * Exists because the option form is awkward for the common case: the
   * heartbeat is usually built before the object that knows how to react to a
   * dead peer, and threading a closure through the constructor inverts that
   * dependency.
   * @param {(missedBeats: number, lastBeatAt: number) => void} cb
   * @returns {void}
   */
  onTimeout(cb) {
    this._onTimeout = typeof cb === 'function' ? cb : null;
  }

  /**
   * @returns {boolean} Whether checks are currently scheduled.
   */
  isRunning() {
    return this._running;
  }

  /**
   * @returns {number} Consecutive checks that found no `beat()`.
   */
  get missedBeats() {
    return this._missedBeats;
  }

  /**
   * @returns {number} Timestamp of the last `beat()`, or `0` if there was none.
   */
  get lastBeatAt() {
    return this._lastBeatAt;
  }

  /**
   * @returns {boolean} Whether the peer has been declared dead and has not
   *   since called `beat()`.
   */
  get timedOut() {
    return this._timedOut;
  }

  /**
   * The next delay, jittered.
   *
   * Jitter is applied to the *scheduled* interval rather than to the deadline,
   * so a peer that beats on time is never failed for arriving early: the
   * deadline is `timeout` after the last beat, and only the polling cadence
   * moves.
   * @returns {number}
   */
  _nextDelay() {
    if (this._jitter <= 0) return this._interval;
    // Full jitter in [-jitter, +jitter] of the interval, clamped so the delay
    // stays positive. `Math.random()` is the right source here: this is
    // decorrelation, not cryptography.
    const spread = this._interval * this._jitter;
    const offset = (Math.random() * 2 - 1) * spread;
    return Math.max(1, this._interval + offset);
  }

  _schedule() {
    if (!this._running || this._disposed) return;
    this._clearTimer();
    this._timer = setTimeout(() => {
      this._timer = null;
      this._check();
    }, this._nextDelay());
  }

  _check() {
    if (!this._running || this._disposed) return;
    const now = this._now();
    const since = this._lastBeatAt === 0 ? Infinity : now - this._lastBeatAt;
    if (since >= this._timeout) {
      this._missedBeats += 1;
      this._timedOut = true;
      if (this._onTimeout) {
        try {
          this._onTimeout(this._missedBeats, this._lastBeatAt);
        } catch {
          // A throwing timeout handler must not stop the schedule: the next
          // check is what eventually reports a peer that recovered, and
          // losing it would turn one bad callback into a silent heartbeat.
        }
      }
    }
    this._schedule();
  }

  _clearTimer() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /**
   * Release the timer.
   *
   * This helper **owns a timer**, so `dispose()` clears it - it is not a state
   * reset. The distinction matters for `using` / `await using`: a heartbeat
   * left scheduled after its owner is gone keeps the event loop alive and
   * keeps firing a callback into a torn-down object.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
    this._onTimeout = null;
    this._onBeat = null;
  }

  [Symbol.dispose]() {
    this.dispose();
  }

  async [Symbol.asyncDispose]() {
    this.dispose();
    return;
  }
}

export default PowerHeartbeat;
