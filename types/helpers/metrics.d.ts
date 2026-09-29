/**
 * Flatten one helper's `stats()` into scalar series keys.
 *
 * Nested objects are joined with a dot rather than dropped, so `size` and a
 * hypothetical `pooled.used` coexist without a naming scheme. Arrays are
 * **omitted** rather than joined: `getStats().status` is an array of per-worker
 * objects whose length means worker count and whose contents are the real
 * detail. Turning that into a string key would put an arbitrary, unbounded
 * number of series into the map, and joining it into one would hide the detail
 * the caller came for.
 *
 * @param {string} helper - The helper name, used as the series prefix.
 * @param {*} stats - Whatever that helper's `stats()` returned.
 * @returns {Record<string, number|boolean|null|string>} Flat scalar series.
 * @example
 * toSeries('cache', new PowerCache().stats());
 * // => { 'cache.size': 0, 'cache.hitRate': 0, 'cache.pool.size': 16, ... }
 */
export function toSeries(helper: string, stats: any): Record<string, number | boolean | null | string>;
/**
 * Wire a helper's `stats()` into a collector, and hand back the receipt that
 * undoes it.
 *
 * The receipt is not optional bookkeeping. A collector holds a closure over the
 * instance, so a disposed pool that is never unregistered is sampled forever -
 * and after `terminate()` its `getStats()` still answers, so nothing fails
 * visibly while the series quietly reports a dead object. Passing the receipt
 * to {@link detach} on teardown is what makes the two halves agree.
 *
 * @param {Object} instance - The helper being registered.
 * @param {string} name - Series prefix. Use a discriminator when more than one
 *   of the same helper is in one process, e.g. `cache.images`.
 * @param {Object} [options] - The helper's own options object.
 * @param {boolean|MetricsCollector} [options.observability] `true` for the
 *   shared collector, or a collector to register with. Anything else — the
 *   default `false`, a bad value — registers nothing and costs nothing.
 * @returns {{unregister: function(): boolean, name: string}|null} The receipt,
 *   or `null` when the helper is not observable. The receipt carries a bound
 *   `unregister` rather than the collector, which is what lets every helper's
 *   `_metrics` field stay a plain object type in the published declarations —
 *   a bare class name here would be emitted into nine `.d.ts` files with no
 *   import to resolve it against.
 * @example
 * const cache = new PowerCache({ observability: true });
 * defaultMetrics.snapshot().series; // { 'cache.size': 0, ... }
 */
export function attach(instance: Object, name: string, options?: {
    observability?: boolean | MetricsCollector | undefined;
}): {
    unregister: () => boolean;
    name: string;
} | null;
/**
 * Undo an {@link attach}. Safe to call with `null`, so a helper can call it
 * from a teardown path that may never have attached.
 *
 * @param {{unregister: function(): boolean, name: string}|null} receipt
 * @returns {boolean} Whether a source was removed.
 */
export function detach(receipt: {
    unregister: () => boolean;
    name: string;
} | null): boolean;
/**
 * FEAT-007, part one of two: a stable shape over the numbers that already exist.
 *
 * Every helper that reports anything does it through its own `stats()`, and
 * those shapes are not merely different — they are *different kinds of thing*.
 * `PowerCache.stats()` is counters. `PowerGCRA.stats()` is largely
 * *configuration* (`rate`, `per`, `burst`) plus one state variable (`tat`).
 * `PowerEventLoopMonitor.stats()` is measurements. `PowerPool.getStats()`
 * contains a *nested array* of per-worker objects. A dashboard that wants to
 * plot "cache hit rate" beside "event-loop p99" currently has to know all of
 * that, and re-learn it whenever a helper's internals move.
 *
 * The fix is not more counters. Every number reported here already exists; the
 * job is a **stable shape** over them, so a second source of truth — the thing
 * that would drift — is never introduced.
 *
 * ## What this deliberately is not
 *
 * It is not an `observability: true` option on the helpers. That is the second
 * half, and it is nine helpers in one commit: shipping it for one helper would
 * make `observability: true` mean three different things across nine, which is
 * worse than not having it. What lands here is the part that is complete and
 * useful on its own — take any helper's `stats()`, get a flat, versioned,
 * point-in-time snapshot.
 *
 * ## The flat-series tradeoff
 *
 * `series` is a flat map of scalars, not the helpers' nested objects. That is
 * what makes it flat: `cache.hitRate` and `loop.p99` become addressable without
 * knowing which helper produced them. The cost is that a nested object is
 * either absent from the series or appears as one joined key — a caller that
 * wants per-worker detail must keep using `getStats()`. Both are supported;
 * `snapshot()` does the flattening, and the original is always one call away.
 */
/**
 * The snapshot format version.
 *
 * Bumped when the *shape* changes, not when a helper adds a field: adding a
 * key is additive and does not break a consumer that reads named series. A
 * consumer pins this to detect a shape change it was not written for.
 *
 * @type {number}
 */
export const METRICS_VERSION: number;
/**
 * Collects point-in-time snapshots from one or more helpers.
 *
 * A collector does not own the helpers. It is handed their `stats()` — however
 * often you choose, and a *reference* rather than the instance, so a caller can
 * sample a pool every request and a cache every minute through the same
 * collector. Sampling is therefore the caller's decision, and the deliberate
 * design point is that **draining is explicit** rather than push-based: a
 * metrics sink that fires on every operation is a metrics sink that becomes a
 * performance problem, and a timer that does it for you is one you cannot turn
 * off.
 *
 * @example
 * const cache = new PowerCache();
 * const metrics = new MetricsCollector();
 *
 * metrics.register('cache', () => cache.stats());
 * // ... later
 * const { version, series } = metrics.snapshot();
 * series['cache.hitRate']; // stable key, whatever cache.stats() is shaped like
 */
export class MetricsCollector {
    /**
     * @param {Object} [options]
     * @param {string} [options.prefix=''] Prepended to every series key, so two
     *   collectors in one process do not collide.
     */
    constructor(options?: {
        prefix?: string | undefined;
    });
    /** @type {Map<string, () => *>} */
    _sources: Map<string, () => any>;
    _prefix: string;
    /**
     * Register a named source. The callback is called on each `snapshot()` and
     * should return that helper's `stats()`.
     *
     * Re-registering a name replaces the previous source rather than adding a
     * second series for it, so a caller that re-registers on reconfigure does not
     * silently double-count.
     *
     * @param {string} name - Series prefix for this source.
     * @param {() => *} read - Returns the source's current stats.
     * @returns {this}
     */
    register(name: string, read: () => any): this;
    /**
     * Stop reporting a source. The key disappears from the next snapshot rather
     * than reporting its last known value, which would be a lie: a number frozen
     * at deregistration looks exactly like a number that stopped moving.
     *
     * @param {string} name
     * @returns {boolean} Whether a source was removed.
     */
    unregister(name: string): boolean;
    /**
     * Take a point-in-time snapshot of every registered source.
     *
     * One source throwing does not lose the others. A metrics sink that goes
     * blank because one helper misbehaved is worse than one that reports
     * everything except the broken thing, so the failure is recorded under
     * `<name>.error` and the rest is still collected.
     *
     * @returns {{version: number, collectedAt: number, sources: string[], series: Record<string, *>, errors: Record<string, string>}}
     */
    snapshot(): {
        version: number;
        collectedAt: number;
        sources: string[];
        series: Record<string, any>;
        errors: Record<string, string>;
    };
    /**
     * The registered source names.
     *
     * @returns {string[]}
     */
    names(): string[];
}
/**
 * A process-wide collector, used by `observability: true`.
 *
 * Deliberately shared rather than per-helper: a caller who opts nine helpers
 * in wants nine series in *one* snapshot, not nine snapshots they have to
 * merge. The default is off everywhere, so a process that never asks for this
 * never allocates a collector or a closure.
 */
export const defaultMetrics: MetricsCollector;
