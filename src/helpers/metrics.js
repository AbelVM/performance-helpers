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
export const METRICS_VERSION = 1;

/** Separator between a helper name and a series key. */
const SEP = '.';

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
export function toSeries(helper, stats) {
  /** @type {Record<string, number|boolean|null|string>} */
  const out = {};
  if (typeof helper !== 'string' || helper === '') return out;
  if (stats == null || typeof stats !== 'object') return out;

  /**
   * @param {*} value
   * @param {string} prefix
   */
  const walk = (value, prefix) => {
    for (const [key, v] of Object.entries(value)) {
      const name = prefix ? `${prefix}${SEP}${key}` : key;
      if (v == null) {
        // A field the helper does not have is a real answer — `tat` is null on
        // a GCRA that has never been called — and dropping it would make an
        // absent field indistinguishable from an unmeasured one.
        out[name] = null;
      } else if (Array.isArray(v)) {
        // Omitted deliberately; see the note above. Arrays are the only shape
        // `stats()` produces that cannot be flattened without inventing a
        // cardinality that is not in the data.
      } else if (typeof v === 'object') {
        walk(v, name);
      } else if (typeof v === 'number' && !Number.isFinite(v)) {
        // `Infinity` is meaningful for a rate limit — "unlimited" — and
        // `NaN` means an unset state. Both are kept as strings rather than
        // coerced, so a consumer cannot mistake one for a real measurement.
        out[name] = String(v);
      } else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
        out[name] = v;
      }
      // Functions and symbols are dropped: no `stats()` returns them today, and
      // a consumer cannot do anything with one in a metrics map.
    }
  };
  walk(stats, helper);
  return out;
}

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
  constructor(options = {}) {
    /** @type {Map<string, () => *>} */
    this._sources = new Map();
    this._prefix = typeof options?.prefix === 'string' ? options.prefix : '';
  }

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
  register(name, read) {
    if (typeof name !== 'string' || name === '') {
      throw new TypeError('MetricsCollector.register: `name` must be a non-empty string');
    }
    if (typeof read !== 'function') {
      throw new TypeError('MetricsCollector.register: `read` must be a function');
    }
    this._sources.set(name, read);
    return this;
  }

  /**
   * Stop reporting a source. The key disappears from the next snapshot rather
   * than reporting its last known value, which would be a lie: a number frozen
   * at deregistration looks exactly like a number that stopped moving.
   *
   * @param {string} name
   * @returns {boolean} Whether a source was removed.
   */
  unregister(name) {
    return this._sources.delete(name);
  }

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
  snapshot() {
    /** @type {Record<string, number|boolean|null|string>} */
    const series = {};
    /** @type {Record<string, string>} */
    const errors = {};
    for (const [name, read] of this._sources) {
      let stats;
      try {
        stats = read();
      } catch (err) {
        errors[name] = err instanceof Error ? err.message : String(err);
        continue;
      }
      const flat = toSeries(this._prefix + name, stats);
      for (const [k, v] of Object.entries(flat)) series[k] = v;
    }
    return {
      version: METRICS_VERSION,
      collectedAt: Date.now(),
      sources: [...this._sources.keys()],
      series,
      errors,
    };
  }

  /**
   * The registered source names.
   *
   * @returns {string[]}
   */
  names() {
    return [...this._sources.keys()];
  }
}

/**
 * A process-wide collector, used by `observability: true`.
 *
 * Deliberately shared rather than per-helper: a caller who opts nine helpers
 * in wants nine series in *one* snapshot, not nine snapshots they have to
 * merge. The default is off everywhere, so a process that never asks for this
 * never allocates a collector or a closure.
 */
export const defaultMetrics = new MetricsCollector();

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
export function attach(instance, name, options) {
  const requested = options?.observability;
  // Anything falsy means "off". Anything else must be `true` or a collector —
  // validated rather than ignored, because the ignored case is the same failure
  // this library has elsewhere: `observability: 'yes'` is truthy, is not `true`,
  // and has no `register`, so it used to register nothing and say nothing. A
  // caller who asked to be measured and was not would never find out.
  if (!requested) return null;
  if (requested === true) {
    // fall through to the shared collector below
  } else if (typeof requested === 'object' && typeof requested.register === 'function') {
    // fall through to the caller's own collector below
  } else {
    throw new TypeError(
      `${name}: \`observability\` must be \`true\` or a MetricsCollector, ` +
        `not ${typeof requested} (${String(requested)}).`
    );
  }
  const collector = requested === true ? defaultMetrics : /** @type {*} */ (requested);
  const target = /** @type {{getStats?: function(): *, stats?: function(): *}} */ (
    /** @type {*} */ (instance)
  );
  const getStats = target?.getStats;
  const stats = target?.stats;
  const read =
    typeof getStats === 'function'
      ? () => getStats.call(target)
      : typeof stats === 'function'
        ? () => stats.call(target)
        : null;
  // A helper with no stats has nothing to report. Registering it would produce
  // an empty series that reads as "this helper is idle" rather than "this
  // helper cannot be observed", so it registers nothing.
  if (!read) return null;
  collector.register(name, read);
  return { name, unregister: () => collector.unregister(name) };
}

/**
 * Undo an {@link attach}. Safe to call with `null`, so a helper can call it
 * from a teardown path that may never have attached.
 *
 * @param {{unregister: function(): boolean, name: string}|null} receipt
 * @returns {boolean} Whether a source was removed.
 */
export function detach(receipt) {
  if (!receipt || typeof receipt.unregister !== 'function') return false;
  return receipt.unregister();
}
