import { PowerHistogram } from './powerHistogram.js';
import { setSafeTimeout } from '../utils/timers.js';
import { nowMs } from '../utils/now.js';
import { attach, detach } from './metrics.js';
import { detectEnv } from './WorkerAgnostic.js';
import { assertKnownOptions } from '../utils/options.js';

/**
 * @typedef {import('./jsdoc-types.js').EventLoopMonitorOptions} EventLoopMonitorOptions
 */

/**
 * Measure how long the event loop is unavailable.
 *
 * Latency has a floor, and nothing in this library can tell you why latency
 * rose. A `PowerHistogram` of your own operation timings shows *that* it rose;
 * this shows whether the host was busy. A p99 that tracks your database's p99
 * is a different problem from a p99 that only degrades once a minute, and the
 * two look identical from inside the operation.
 *
 * The measurement is timer drift: a timer is scheduled for `intervalMs` in the
 * future, and when it actually runs the gap is the event loop having been
 * unavailable. That is the same technique Node's own diagnostics use, and it
 * catches the case that matters most - a synchronous block - because the timer
 * simply cannot fire until the block finishes.
 *
 * `utilization()` is separate and optional: it reports Node's
 * `eventLoopUtilization()` when the runtime has it (Node >= 14.5) and `null`
 * everywhere else. The Node built-in is resolved lazily through an opaque
 * dynamic import so bundlers never try to resolve `node:perf_hooks`; await
 * {@link PowerEventLoopMonitor#ready} before the first read if you need it
 * populated.
 *
 * @example
 * const monitor = new PowerEventLoopMonitor({ intervalMs: 20 });
 * monitor.start();
 * setInterval(() => {
 *   const s = monitor.stats();
 *   if (s.p99 > 50) console.warn('event loop blocked', s.max);
 * }, 5000);
 * // monitor.dispose() when done
 *
 * @class PowerEventLoopMonitor
 * @public
 */
export class PowerEventLoopMonitor {
  /**
   * @param {EventLoopMonitorOptions} [options]
   */
  constructor(options = {}) {
    assertKnownOptions(
      options,
      [
        'intervalMs',
        'observability',
        'relativeAccuracy',
        'onDrift',
        'keepProcessAlive',
        'utilizationProvider',
      ],
      'PowerEventLoopMonitor'
    );
    const {
      intervalMs = 20,
      relativeAccuracy = 0.01,
      onDrift = null,
      keepProcessAlive = false,
      utilizationProvider = null,
    } = options;

    if (!Number.isFinite(intervalMs) || intervalMs < 1) {
      throw new TypeError('PowerEventLoopMonitor: `intervalMs` must be a finite number >= 1');
    }
    if (typeof onDrift !== 'function' && onDrift !== null) {
      throw new TypeError('PowerEventLoopMonitor: `onDrift` must be a function or null');
    }

    /** @type {number} */
    this.intervalMs = Math.floor(intervalMs);
    /** @type {?function(number):void} */
    this._onDrift = onDrift;
    /** @type {boolean} */
    this._keepProcessAlive = keepProcessAlive;

    this._delay = new PowerHistogram({ relativeAccuracy });
    this._samples = 0;
    this._sum = 0;
    this._max = 0;
    this._lastDelay = 0;
    this._blocked = 0;
    // OBS-007. The three things that made a stall invisible.
    //
    // `_blockedMs` is the same population as `_blocked` measured in milliseconds
    // rather than in ticks, so a 30 s stall and a 12 ms hiccup stop reading the
    // same: both are `blockedOver10ms: 1`, and only one of them is `blockedMs:
    // 30000`. Counting was the right call for alert rate; it is the wrong shape
    // for severity, and severity is the question being asked when a loop is in
    // trouble.
    this._blockedMs = 0;
    // Readings refused because the clock moved backwards (NTP correction, a
    // suspended laptop). They were dropped rather than recorded, because a
    // negative sample poisons the histogram - but a **dropped sample is still an
    // event**, and an event with no counter is indistinguishable from an event
    // that did not happen.
    this._dropped = 0;
    // Wall-clock baseline for `coverage`. Re-based by `reset()`, because a
    // coverage figure whose window the caller has just cleared is a lie about the
    // cleared interval.
    this._startedAt = nowMs();
    this._running = false;
    this._handle = null;

    /**
     * Resolves once the Node `perf_hooks` lookup has settled, if it was
     * attempted. Never rejects: a runtime without it simply leaves
     * {@link PowerEventLoopMonitor#utilization} returning `null`.
     * @type {Promise<void>}
     */
    this.ready = Promise.resolve();

    if (typeof utilizationProvider === 'function') {
      this._utilizationSource = utilizationProvider;
    } else if (detectEnv() === 'node') {
      this.ready = this._resolveNodeUtilization();
    } else {
      /** @type {?function():*} */
      this._utilizationSource = null;
    }
    // FEAT-007: opt-in metrics. Off by default, so the common case pays nothing and allocates no closure.
    this._metrics = attach(this, 'loop', options);
  }

  /**
   * Begin sampling. Idempotent: a second call while running is a no-op.
   * @returns {this}
   */
  start() {
    if (this._running) return this;
    this._running = true;
    this._schedule();
    return this;
  }

  /**
   * Stop sampling. In-flight samples already recorded are kept, so a stop/start
   * cycle does not lose history. Idempotent.
   *
   * **This does not unregister the metrics receipt**, and that is the whole
   * point. It used to, which meant a stop/start cycle — the exact cycle this
   * method's own JSDoc invites, and one an app performs on a debug toggle or a
   * pause — left the monitor sampling and reporting nothing, permanently and
   * silently. `start()` does not re-attach, so there was no way back short of
   * constructing a new monitor and losing the collected history as well.
   * Eight other helpers detach in teardown only; this was the only one that
   * detached in a method documented as reversible. Use {@link
   * PowerEventLoopMonitor#dispose} to unregister.
   *
   * @returns {this}
   */
  stop() {
    this._running = false;
    if (this._handle !== null) {
      clearTimeout(this._handle);
      this._handle = null;
    }
    return this;
  }

  /**
   * The drift histogram. Owned by the monitor; do not call `reset()` on it
   * directly, use {@link PowerEventLoopMonitor#reset} so the counters agree.
   * @returns {PowerHistogram}
   */
  histogram() {
    return this._delay;
  }

  /**
   * Clear all recorded samples, as if the monitor were brand new. Does not stop
   * sampling.
   * @returns {void}
   */
  reset() {
    this._delay.reset();
    this._samples = 0;
    this._sum = 0;
    this._max = 0;
    this._lastDelay = 0;
    this._blocked = 0;
    this._blockedMs = 0;
    this._dropped = 0;
    // The coverage window restarts with the samples, or coverage would keep
    // dividing a fresh sample count by the whole life of the monitor.
    this._startedAt = nowMs();
  }

  /**
   * Alias for {@link PowerEventLoopMonitor#reset}.
   *
   * `reset()` here *is* a clear — it discards every accumulated sample, so both
   * words describe the same act. Contrast the limiters, where `reset()` restores
   * a usable state and `clear()` would read as the opposite.
   *
   * @returns {void}
   */
  clear() {
    this.reset();
  }

  /**
   * The last recorded drift, in milliseconds. `0` before the first sample.
   * @returns {number}
   */
  lastDelay() {
    return this._lastDelay;
  }

  /**
   * Node's `eventLoopUtilization()` reading, or `null` where the runtime does
   * not provide it.
   *
   * `null` is a real answer, not a zero: outside Node there is no such
   * measurement, and reporting `0` would read as a perfectly idle loop. Await
   * {@link PowerEventLoopMonitor#ready} first, or pass a `utilizationProvider`.
   *
   * @returns {{active:number, idle:number, utilization:number}|null}
   */
  utilization() {
    if (!this._utilizationSource) return null;
    try {
      const raw = this._utilizationSource();
      if (!raw || typeof raw !== 'object') return null;
      return {
        active: Number(raw.active) || 0,
        idle: Number(raw.idle) || 0,
        utilization: Number(raw.utilization) || 0,
      };
    } catch {
      // A throwing provider must not take the monitor down with it: the drift
      // histogram is the primary output and it does not depend on this at all.
      return null;
    }
  }

  /**
   * Event-loop utilisation over the interval between two readings.
   *
   * **This is the half that makes the built-in worth reaching for**, and
   * {@link PowerEventLoopMonitor#utilization} does not provide it. `utilization()`
   * hands back Node's *cumulative* reading — `active` and `idle` grow without
   * bound for the life of the process — so it answers "how busy has this process
   * been since it started", which is a lifetime average and barely moves. The
   * property ELU actually has, and the reason the row recommends it, is that it
   * is **defined over a measured interval**: subtract two readings and you have
   * that interval's active and idle time exactly.
   *
   * Measured, and the reason this is not a nicety. A 1 s synchronous block
   * followed by one macrotask reads `active` +1000 ms against +20 ms idle. But
   * the same block read at a different moment in the process's life reported
   * **+0.2 ms** — because ELU's counters are refreshed by the loop, and a
   * reading taken at the wrong moment misses the interval entirely. Handing
   * back a cumulative number and hoping the caller spaces its reads is how that
   * goes wrong; the interval has to be explicit.
   *
   * ```js
   * let mark = monitor.utilization();
   * setInterval(() => {
   *   const window = monitor.utilizationSince(mark);
   *   mark = monitor.utilization();
   *   if (window && window.active > 100) console.warn('blocked', window.active);
   * }, 1000);
   * ```
   *
   * @param {{active:number, idle:number, utilization:number}|null} previous -
   *   A reading from an earlier {@link PowerEventLoopMonitor#utilization} call.
   * @returns {{active:number, idle:number, utilization:number, ratio:number, elapsed:number}|null}
   *   `null` when ELU is unavailable or `previous` is `null`, so a caller can
   *   distinguish "no data" from "zero utilisation". `elapsed` is the interval
   *   in ms — `active + idle` — and `ratio` is `active / elapsed`, which is
   *   `0` rather than `NaN` for an empty interval.
   */
  utilizationSince(previous) {
    const current = this.utilization();
    if (!previous || !current) return null;
    const active = current.active - previous.active;
    const idle = current.idle - previous.idle;
    // A reading that goes backwards means the provider was replaced or the
    // process's counters reset. Reporting a negative interval would be worse
    // than reporting nothing.
    if (active < 0 || idle < 0) return null;
    const elapsed = active + idle;
    return {
      active,
      idle,
      utilization: current.utilization,
      elapsed,
      ratio: elapsed > 0 ? active / elapsed : 0,
    };
  }

  /**
   * Serializable snapshot of the configuration and the recorded samples.
   *
   * `mean`, `p50`, `p99` and `p99_9` are `null` before the first sample rather
   * than `0`, so a consumer cannot mistake "not measured yet" for "no delay".
   * They are *estimates* - `PowerHistogram` is a DDSketch with a
   * `relativeAccuracy` bound - not exact quantiles.
   *
   * @returns {{
   *   active: boolean,
   *   intervalMs: number,
   *   samples: number,
   *   last: number,
   *   max: number,
   *   mean: number|null,
   *   p50: number|null,
   *   p99: number|null,
   *   p99_9: number|null,
   *   blockedOver10ms: number,
   *   blockedMs: number,
   *   droppedSamples: number,
   *   coverage: number|null
   * }}
   */
  stats() {
    const hasSamples = this._samples > 0;
    // OBS-007. **Coverage is a lifetime figure, and it trends down — read it as a
    // resolution statement, not a health statement.** It answers "what fraction of
    // the wall-clock time since this monitor started does its own sampling schedule
    // account for?", which is `(samples - 1) * intervalMs + totalDrift` over the
    // elapsed time. That is why it is not an alertable ratio on its own: a monitor
    // at `intervalMs: 10` that has been running for an hour covers 0.03 of it, and
    // a loop that has been perfectly responsive the whole time scores the same as
    // one that stalled for 2 minutes and then recovered.
    //
    // What it is for is the case every other field here gets wrong. `max` and
    // `blockedOver10ms` can only describe ticks that **fired**. If the monitor was
    // not sampling — stopped, or never started, or the process was suspended past
    // the timer entirely — no tick fires, no drift is recorded, and the gap is
    // invisible in every other field. Coverage is the only number here that moves
    // when time passed unobserved.
    //
    const elapsed = nowMs() - this._startedAt;
    const accounted = hasSamples ? (this._samples - 1) * this.intervalMs + this._sum : 0;
    // `null` in three cases, and all three are one fact: there is no window to take
    // a fraction of.
    //
    // - no samples yet, for the same reason `mean` is `null` and not `0`. "Not
    //   measured yet" and "measured, accounted for nothing" are different facts.
    // - `elapsed === 0`, a window of no length. Not hypothetical in this repo: the
    //   suite's fake timers freeze `nowMs()`, so every test using them sits in
    //   exactly this state, and `0 / 0` is `NaN` - which compares false against
    //   *every* threshold, so it would silence a caller's coverage alert while
    //   still looking like a number.
    // - `elapsed < 0`, the wall clock stepping backwards (NTP correction, a
    //   suspended laptop) so the window runs the wrong way. `1` was the answer
    //   written here first, and it is the worst one available: "fully covered" is
    //   the single reading that silences an alert. `droppedSamples` is the tell
    //   that this clock is not to be trusted.
    //
    // Clamped at both ends. The upper bound is a clock stepping *backwards* under an
    // already-recorded window: the denominator shrinks, the numerator does not, and
    // the ratio reports more than everything.
    const coverage =
      hasSamples && elapsed > 0 ? Math.min(1, Math.max(0, accounted / elapsed)) : null;
    return {
      active: this._running,
      intervalMs: this.intervalMs,
      samples: this._samples,
      last: this._lastDelay,
      max: this._max,
      mean: hasSamples ? this._sum / this._samples : null,
      p50: hasSamples ? (this._delay.percentile(50) ?? null) : null,
      p99: hasSamples ? (this._delay.percentile(99) ?? null) : null,
      p99_9: hasSamples ? (this._delay.percentile(99.9) ?? null) : null,
      // A count, not a rate, so it is meaningful over any window. Drift above
      // 10ms is the threshold worth alerting on for most services; it is a
      // count rather than a verdict because the right number is workload
      // specific.
      blockedOver10ms: this._blocked,
      // The same population as `blockedOver10ms`, in milliseconds. The pair is the
      // point: one is how *often*, the other is how *badly*.
      blockedMs: this._blockedMs,
      // Ticks refused because the clock moved backwards. Non-zero means the drift
      // figures on this monitor are from a clock that was adjusted under them,
      // which is worth knowing before you trust a percentile.
      droppedSamples: this._dropped,
      coverage,
    };
  }

  /**
   * Alias for {@link stats}, so a caller who learned `getStats()` from
   * `PowerPool` — the one class that has always spelled it this way — is not
   * handed `TypeError: x.getStats is not a function` here.
   *
   * Nine helpers spell the reporting method `stats()` and `PowerPool` spelled it
   * `getStats()`, with no stated rule and nothing pinning it, which reached the
   * documentation as a false claim (`guides/metrics.md`, `llm.txt`). Both
   * spellings work everywhere now. `stats()` is canonical and this delegates to
   * it; `PowerPool` keeps `getStats` because renaming the largest surface in the
   * library would be a breaking change.
   *
   * Written out per class rather than installed on the prototype on purpose: a
   * dynamic `Object.defineProperty` is invisible to `tsc`, so the generated
   * `types/` omitted it and a TypeScript caller got a type error on a method
   * that worked at runtime. That was the first implementation.
   *
   * **No `@returns` tag, and that is load-bearing.** The first version carried a
   * hand-copied copy of the `stats()` return shape, on the reasoning that an
   * explicit type was safer. It is not: the copy went stale the moment a
   * concurrent change added `staleServes` and `expirations` to `PowerCache`
   * `.stats()`, and `test/statsNaming.test.js` failed. Inference gives a
   * byte-identical published type and cannot drift, because there is nothing to
   * keep in sync. `test/types.test-d.ts` asserts the two are mutually assignable,
   * which is the property a consumer relies on.
   */
  getStats() {
    return this.stats();
  }

  /**
   * Stop sampling and release the timer. Safe to call more than once.
   *
   * This is the only thing that unregisters the metrics receipt, and it is
   * terminal: after it, `getStats()` still answers but the monitor reports
   * nothing, because the collector no longer calls it.
   *
   * @returns {void}
   */
  dispose() {
    // Detach before `stop()`, and not after: `stop()` is idempotent and
    // order-independent now, so this is only about the receipt being gone by
    // the time the timer is cancelled.
    detach(this._metrics);
    this._metrics = null;
    this.stop();
    this._onDrift = null;
    this._utilizationSource = null;
  }

  [Symbol.dispose]() {
    this.dispose();
  }

  /**
   * @returns {void}
   * @private
   */
  _schedule() {
    if (!this._running) return;
    const scheduledFor = nowMs() + this.intervalMs;
    this._handle = setSafeTimeout(
      () => {
        this._handle = null;
        if (!this._running) return;
        this._record(nowMs() - scheduledFor);
        this._schedule();
      },
      this.intervalMs,
      { keepProcessAlive: this._keepProcessAlive }
    );
  }

  /**
   * @param {number} drift - Milliseconds the timer was late by.
   * @returns {void}
   * @private
   */
  _record(drift) {
    // A negative reading means the clock moved backwards (NTP correction, a
    // suspended laptop). Recording it would poison the histogram's invariants,
    // so it is dropped and the gap goes unreported rather than reported wrong.
    if (!(drift >= 0)) {
      this._dropped += 1;
      return;
    }
    this._lastDelay = drift;
    this._samples += 1;
    this._sum += drift;
    if (drift > this._max) this._max = drift;
    if (drift > 10) {
      this._blocked += 1;
      this._blockedMs += drift;
    }
    this._delay.record(drift);

    if (this._onDrift) {
      try {
        this._onDrift(drift);
      } catch {
        // A throwing user hook must not stop the monitor or kill the loop.
      }
    }
  }

  /**
   * Resolve Node's `eventLoopUtilization` without a static import, so bundlers
   * never try to resolve `node:perf_hooks` for a browser build.
   * @returns {Promise<void>}
   * @private
   */
  async _resolveNodeUtilization() {
    /** @type {?function():*} */
    this._utilizationSource = null;
    try {
      const mod = await new Function('return import("node:perf_hooks")')();
      const fn = mod?.eventLoopUtilization;
      this._utilizationSource = typeof fn === 'function' ? () => fn() : null;
    } catch {
      // Node < 14.5, a bundler that inlined the import, or a stripped build.
      this._utilizationSource = null;
    }
  }
}

export default PowerEventLoopMonitor;
