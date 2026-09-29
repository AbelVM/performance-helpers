import { describe, it, expect, vi } from 'vitest';
import { MetricsCollector, toSeries, METRICS_VERSION } from '../src/helpers/metrics.js';
import { PowerCache } from '../src/helpers/powerCache.js';
import { PowerGCRA } from '../src/helpers/powerGCRA.js';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * FEAT-007, part one: the stable shape.
 *
 * The contract being pinned is a *schema* claim, so most of these tests are
 * about what must and must not appear rather than about arithmetic. That is
 * deliberate: the failure this exists to prevent is a dashboard that silently
 * stops finding a key, which is invisible until a graph goes flat.
 *
 * The teeth check is the last test: a `toSeries` that returned `{}` would pass
 * every test above, so one case asserts real keys for real helpers.
 */

describe('toSeries', () => {
  it('flattens nested objects into dotted keys, prefixed by the helper name', () => {
    const out = toSeries('cache', { size: 3, timePerTask: { average: 1.5, max: 4 } });
    expect(out).toEqual({
      'cache.size': 3,
      'cache.timePerTask.average': 1.5,
      'cache.timePerTask.max': 4,
    });
  });

  it('keeps a null field, because absent and unmeasured are different answers', () => {
    // `PowerGCRA.tat` is null until the first call. Dropping the key would
    // make "never called" indistinguishable from "not reported", and a
    // dashboard would draw a gap either way.
    const out = toSeries('gcra', { tat: null, rate: 10 });
    expect(out).toEqual({ 'gcra.tat': null, 'gcra.rate': 10 });
  });

  it('preserves Infinity and NaN as strings rather than coercing them', () => {
    // Both are real values here: `Infinity` is how a rate limit says
    // "unlimited" and NaN is an unset state. Coerced to 0 or dropped, both
    // would read as a measurement of zero.
    const out = toSeries('x', { a: Number.POSITIVE_INFINITY, b: Number.NaN });
    expect(out).toEqual({ 'x.a': 'Infinity', 'x.b': 'NaN' });
  });

  it('omits arrays rather than inventing a cardinality', () => {
    // `PowerPool.getStats().status` is one entry per worker. Joining it into a
    // key would put an unbounded number of series in the map, and dropping the
    // contents would hide the detail the caller came for. The caller keeps
    // using getStats() for that.
    const out = toSeries('pool', { activeTasks: 2, status: [{ id: 0 }, { id: 1 }] });
    expect(out).toEqual({ 'pool.activeTasks': 2 });
    expect(Object.keys(out).some((k) => k.includes('status'))).toBe(false);
  });

  it('drops functions and symbols, which no stats() returns today', () => {
    const out = toSeries('x', { a: 1, fn: () => {}, sym: Symbol('s') });
    expect(out).toEqual({ 'x.a': 1 });
  });

  it('returns an empty map for a bad helper name or a null stats', () => {
    expect(toSeries('', { a: 1 })).toEqual({});
    expect(toSeries('x', null)).toEqual({});
    expect(toSeries('x', 42)).toEqual({});
  });
});

describe('MetricsCollector', () => {
  it('stamps every snapshot with the version and a collection time', () => {
    const c = new MetricsCollector();
    c.register('cache', () => ({ size: 1 }));
    const snap = c.snapshot();
    // A consumer pins `version` to detect a shape it was not written for.
    // Without it, a rename is indistinguishable from a helper going quiet.
    expect(snap.version).toBe(METRICS_VERSION);
    expect(typeof snap.collectedAt).toBe('number');
    expect(snap.sources).toEqual(['cache']);
  });

  it('prefixes every key when a prefix is configured', () => {
    const c = new MetricsCollector({ prefix: 'app.' });
    c.register('cache', () => ({ size: 1 }));
    // Two collectors in one process would otherwise collide on `cache.size`.
    expect(c.snapshot().series).toEqual({ 'app.cache.size': 1 });
  });

  it('replaces a re-registered source rather than doubling it', () => {
    const c = new MetricsCollector();
    c.register('a', () => ({ v: 1 }));
    c.register('a', () => ({ v: 2 }));
    const snap = c.snapshot();
    // A caller that re-registers on reconfigure must not end up with two
    // series for one helper, or every value silently doubles.
    expect(snap.sources).toEqual(['a']);
    expect(snap.series).toEqual({ 'a.v': 2 });
  });

  it('drops a deregistered source instead of freezing its last value', () => {
    const c = new MetricsCollector();
    c.register('a', () => ({ v: 1 }));
    c.register('b', () => ({ v: 2 }));
    expect(c.unregister('a')).toBe(true);
    expect(c.unregister('a')).toBe(false);
    const snap = c.snapshot();
    // A number frozen at deregistration looks exactly like a number that
    // stopped moving, so the key goes instead.
    expect(snap.series).toEqual({ 'b.v': 2 });
    expect(c.names()).toEqual(['b']);
  });

  it('records a failing source and still collects the others', () => {
    const c = new MetricsCollector();
    c.register('good', () => ({ v: 1 }));
    c.register('bad', () => {
      throw new Error('stats exploded');
    });
    const snap = c.snapshot();
    // A metrics sink that goes blank because one helper misbehaved is worse
    // than one missing the broken thing.
    expect(snap.series).toEqual({ 'good.v': 1 });
    expect(snap.errors.bad).toBe('stats exploded');
  });

  it('rejects a bad registration rather than storing it', () => {
    const c = new MetricsCollector();
    expect(() => c.register('', () => ({}))).toThrow(TypeError);
    // A non-function source would fail at snapshot time, once per sample, far
    // from the mistake.
    expect(() => c.register('a', 'not a function')).toThrow(TypeError);
  });

  it('does not sample until asked', () => {
    const c = new MetricsCollector();
    const read = vi.fn(() => ({ v: 1 }));
    c.register('a', read);
    expect(read).not.toHaveBeenCalled();
    c.snapshot();
    expect(read).toHaveBeenCalledTimes(1);
    // Draining is explicit, not push-based. A sink that fires on every
    // operation becomes a performance problem; a timer that does it for you is
    // one you cannot turn off.
  });
});

describe('against the real helpers', () => {
  it('produces addressable keys for PowerCache', () => {
    const cache = new PowerCache({ maxEntries: 2 });
    cache.set('k', 1);
    cache.get('k');
    const out = toSeries('cache', cache.stats());
    // These are the keys a dashboard would pin. If a refactor renames one, it
    // fails here rather than drawing a flat line.
    expect(out['cache.size']).toBe(1);
    expect(out['cache.hits']).toBe(1);
    expect(out['cache.misses']).toBe(0);
  });

  it('produces addressable keys for PowerGCRA, including its null state', () => {
    const gcra = new PowerGCRA({ rate: 10, per: 1000, burst: 5 });
    const out = toSeries('gcra', gcra.stats());
    // `tat` is null before the first call — the null-preservation rule is not
    // theoretical, this is where it comes from.
    expect(out['gcra.tat']).toBeNull();
    expect(out['gcra.rate']).toBe(10);
  });

  it('omits PowerPool per-worker detail, and says so through size', () => {
    function Silent() {
      this.onmessage = null;
      this.postMessage = () => {};
      this.terminate = () => {};
    }
    const pool = new PowerPool(Silent, { size: 2, minSize: 2, maxSize: 2, lazy: false });
    const out = toSeries('pool', pool.getStats());
    expect(out['pool.activeTasks']).toBe(0);
    expect(Object.keys(out).filter((k) => k.startsWith('pool.status'))).toEqual([]);
    // The detail is still one call away, which is the contract.
    expect(pool.getStats().status).toHaveLength(2);
    pool.terminate();
  });

  it('collects several helpers into one snapshot', () => {
    function Silent() {
      this.onmessage = null;
      this.postMessage = () => {};
      this.terminate = () => {};
    }
    const cache = new PowerCache();
    const pool = new PowerPool(Silent, { size: 1, minSize: 1, maxSize: 1, lazy: false });
    const c = new MetricsCollector();
    c.register('cache', () => cache.stats());
    c.register('pool', () => pool.getStats());
    c.register('gcra', () => new PowerGCRA({ rate: 1, per: 1000 }).stats());
    const { series, errors } = c.snapshot();
    // The point of the module: one map, several helpers, no per-helper knowledge.
    expect(Object.keys(series).some((k) => k.startsWith('cache.'))).toBe(true);
    expect(Object.keys(series).some((k) => k.startsWith('pool.'))).toBe(true);
    expect(Object.keys(series).some((k) => k.startsWith('gcra.'))).toBe(true);
    expect(errors).toEqual({});
    pool.terminate();
  });
});
