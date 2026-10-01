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
    _onDrift: ((arg0: number) => void) | null;
    /** @type {boolean} */
    _keepProcessAlive: boolean;
    _delay: PowerHistogram;
    _samples: number;
    _sum: number;
    _max: number;
    _lastDelay: number;
    _blocked: number;
    _running: boolean;
    _handle: any;
    /**
     * Resolves once the Node `perf_hooks` lookup has settled, if it was
     * attempted. Never rejects: a runtime without it simply leaves
     * {@link PowerEventLoopMonitor#utilization} returning `null`.
     * @type {Promise<void>}
     */
    ready: Promise<void>;
    _utilizationSource: (() => any) | null;
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
    };
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
    private _schedule;
    /**
     * @param {number} drift - Milliseconds the timer was late by.
     * @returns {void}
     * @private
     */
    private _record;
    /**
     * Resolve Node's `eventLoopUtilization` without a static import, so bundlers
     * never try to resolve `node:perf_hooks` for a browser build.
     * @returns {Promise<void>}
     * @private
     */
    private _resolveNodeUtilization;
    [Symbol.dispose](): void;
}
export default PowerEventLoopMonitor;
export type EventLoopMonitorOptions = import("./jsdoc-types.js").EventLoopMonitorOptions;
import { PowerHistogram } from './powerHistogram.js';
