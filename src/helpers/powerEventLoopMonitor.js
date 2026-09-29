import { PowerHistogram } from './powerHistogram.js';
import { setSafeTimeout } from '../utils/timers.js';
import { nowMs } from '../utils/now.js';
import { attach, detach } from './metrics.js';
import { detectEnv } from './WorkerAgnostic.js';

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
   * @returns {this}
   */
  stop() {
    detach(this._metrics);
    this._metrics = null;
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
   *   blockedOver10ms: number
   * }}
   */
  stats() {
    const hasSamples = this._samples > 0;
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
    };
  }

  /**
   * Stop sampling and release the timer. Safe to call more than once.
   * @returns {void}
   */
  dispose() {
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
    if (!(drift >= 0)) return;
    this._lastDelay = drift;
    this._samples += 1;
    this._sum += drift;
    if (drift > this._max) this._max = drift;
    if (drift > 10) this._blocked += 1;
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
