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
    constructor(options?: EventLoopMonitorOptions);
    /** @type {number} */
    intervalMs: number;
    /** @type {?function(number):void} */
    /** @type {boolean} */
    /**
     * Resolves once the Node `perf_hooks` lookup has settled, if it was
     * attempted. Never rejects: a runtime without it simply leaves
     * {@link PowerEventLoopMonitor#utilization} returning `null`.
     * @type {Promise<void>}
     */
    ready: Promise<void>;
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
    /**
     * Begin sampling. Idempotent: a second call while running is a no-op.
     * @returns {this}
     */
    start(): this;
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
    stop(): this;
    /**
     * The drift histogram. Owned by the monitor; do not call `reset()` on it
     * directly, use {@link PowerEventLoopMonitor#reset} so the counters agree.
     * @returns {PowerHistogram}
     */
    histogram(): PowerHistogram;
    /**
     * Clear all recorded samples, as if the monitor were brand new. Does not stop
     * sampling.
     * @returns {void}
     */
    reset(): void;
    /**
     * Alias for {@link PowerEventLoopMonitor#reset}.
     *
     * `reset()` here *is* a clear — it discards every accumulated sample, so both
     * words describe the same act. Contrast the limiters, where `reset()` restores
     * a usable state and `clear()` would read as the opposite.
     *
     * @returns {void}
     */
    clear(): void;
    /**
     * The last recorded drift, in milliseconds. `0` before the first sample.
     * @returns {number}
     */
    lastDelay(): number;
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
    utilization(): {
        active: number;
        idle: number;
        utilization: number;
    } | null;
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
    utilizationSince(previous: {
        active: number;
        idle: number;
        utilization: number;
    } | null): {
        active: number;
        idle: number;
        utilization: number;
        ratio: number;
        elapsed: number;
    } | null;
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
    stats(): {
        active: boolean;
        intervalMs: number;
        samples: number;
        last: number;
        max: number;
        mean: number | null;
        p50: number | null;
        p99: number | null;
        p99_9: number | null;
        blockedOver10ms: number;
        blockedMs: number;
        droppedSamples: number;
        coverage: number | null;
    };
    /**
     * Alias for {@link stats}.
     *
     * See `guides/stats-naming.md` for why both spellings exist and why this
     * method is written out per class.
     */
    getStats(): {
        active: boolean;
        intervalMs: number;
        samples: number;
        last: number;
        max: number;
        mean: number | null;
        p50: number | null;
        p99: number | null;
        p99_9: number | null;
        blockedOver10ms: number;
        blockedMs: number;
        droppedSamples: number;
        coverage: number | null;
    };
    /**
     * Stop sampling and release the timer. Safe to call more than once.
     *
     * This is the only thing that unregisters the metrics receipt, and it is
     * terminal: after it, `getStats()` still answers but the monitor reports
     * nothing, because the collector no longer calls it.
     *
     * @returns {void}
     */
    dispose(): void;
    /**
     * @returns {void}
     * @private
     */
    /**
     * @param {number} drift - Milliseconds the timer was late by.
     * @returns {void}
     * @private
     */
    /**
     * Resolve Node's `eventLoopUtilization` without a static import, so bundlers
     * never try to resolve `node:perf_hooks` for a browser build.
     * @returns {Promise<void>}
     * @private
     */
    [Symbol.dispose](): void;
}
export default PowerEventLoopMonitor;
export type EventLoopMonitorOptions = import("./jsdoc-types.js").EventLoopMonitorOptions;
import { PowerHistogram } from './powerHistogram.js';
