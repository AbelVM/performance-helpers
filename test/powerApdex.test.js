import { describe, it, expect, afterEach } from 'vitest';
import { PowerApdex } from '../src/helpers/powerApdex.js';
import { MetricsCollector, defaultMetrics } from '../src/helpers/metrics.js';

/**
 * APDEX scoring, and the one property that decided its implementation.
 *
 * The formula is three lines and is not what needed testing. What needed testing
 * is the claim in the class doc that this helper keeps **exact integer counters**
 * rather than deriving the score from a `PowerHistogram`, because
 * `bench/claims.js apdex` measured the derived version reading 0.625 where the
 * truth was 0.950. The test named for that case is the one that fails if someone
 * later "simplifies" this into two rank queries over a sketch.
 *
 * Everything else here pins the boundaries, because APDEX has three of them
 * (`target`, `tolerance`, and the empty case) and each one has a wrong answer
 * that looks plausible.
 */
describe('PowerApdex', () => {
  afterEach(() => {
    // `observability: true` registers in the process-wide collector, and a
    // leaked registration is sampled forever — the same leak
    // `test/metrics.lifetime.test.js` guards for the other helpers.
    for (const name of defaultMetrics.names()) defaultMetrics.unregister(name);
  });

  describe('the score', () => {
    it('weights a tolerating sample as half a satisfied one', () => {
      const apdex = new PowerApdex({ target: 100, tolerance: 400 });
      apdex.record(50); // satisfied
      apdex.record(200); // tolerating
      apdex.record(900); // frustrated
      // (1 + 0.5) / 3
      expect(apdex.score()).toBeCloseTo(0.5, 12);
      expect(apdex.stats()).toMatchObject({ satisfied: 1, tolerating: 1, frustrated: 1, total: 3 });
    });

    it('is 1 when every sample is satisfied and 0 when none is', () => {
      const good = new PowerApdex({ target: 100 });
      for (let i = 0; i < 10; i++) good.record(i);
      expect(good.score()).toBe(1);

      const bad = new PowerApdex({ target: 100 });
      for (let i = 0; i < 10; i++) bad.record(1000 + i);
      expect(bad.score()).toBe(0);
    });

    it('puts the boundary values in the class the standard assigns them', () => {
      // `<= target` is satisfied and `<= tolerance` is tolerating. An
      // off-by-one here moves a sample across a class boundary, which is a
      // half-point swing in the score for a request that was exactly on time.
      const apdex = new PowerApdex({ target: 100, tolerance: 400 });
      apdex.record(100);
      apdex.record(400);
      apdex.record(400.0001);
      expect(apdex.stats()).toMatchObject({ satisfied: 1, tolerating: 1, frustrated: 1 });
    });

    it('has no score before anything is recorded', () => {
      // `undefined`, not 0 and not 1. Both of those read as a measurement, and
      // a dashboard that defaults an absent score to 0 pages someone about a
      // service that has not been called yet.
      const apdex = new PowerApdex({ target: 100 });
      expect(apdex.score()).toBeUndefined();
      expect(apdex.stats()).toMatchObject({ satisfied: 0, tolerating: 0, frustrated: 0, total: 0 });
      expect(apdex.stats().score).toBeUndefined();
    });
  });

  describe('thresholds', () => {
    it('defaults tolerance to 4T, the APDEX convention', () => {
      const apdex = new PowerApdex({ target: 100 });
      expect(apdex.tolerance).toBe(400);
      expect(apdex.target).toBe(100);
    });

    it('accepts an explicit tolerance, including one equal to the target', () => {
      // `tolerance === target` is binary APDEX: the tolerating class is empty
      // and the score is satisfied/total. Unusual, but well defined, and
      // rejecting it would refuse a configuration that works.
      const apdex = new PowerApdex({ target: 100, tolerance: 100 });
      apdex.record(50);
      apdex.record(150);
      expect(apdex.stats()).toMatchObject({ satisfied: 1, tolerating: 0, frustrated: 1 });
      expect(apdex.score()).toBe(0.5);
    });

    it('requires a target, because there is no honest default', () => {
      // A guessed threshold scores against the wrong line and still looks like
      // a real number, which is the failure this library refuses everywhere
      // else. `0` is refused for the same reason: it is almost always an
      // uninitialised variable, and it would silently frustrate everything.
      for (const target of [undefined, null, 0, -1, NaN, Infinity, {}, []]) {
        expect(() => new PowerApdex({ target }), `target ${String(target)}`).toThrow(TypeError);
      }
      expect(() => new PowerApdex({})).toThrow(/`target` is required/);
    });

    it('coerces a numeric string, the way every other duration option here does', () => {
      // `'100'` from an environment variable is a reasonable thing to pass, and
      // rejecting it would be pedantry — the same call `normalizeTtl` makes.
      const apdex = new PowerApdex({ target: '100' });
      expect(apdex.target).toBe(100);
      expect(apdex.tolerance).toBe(400);
    });

    it('refuses a tolerance below the target', () => {
      // The tolerating class would be empty and the counts would go negative,
      // so this is a configuration error rather than something to clamp.
      expect(() => new PowerApdex({ target: 100, tolerance: 99 })).toThrow(TypeError);
      expect(() => new PowerApdex({ target: 100, tolerance: NaN })).toThrow(TypeError);
    });

    it('rejects an option it does not accept', () => {
      expect(() => new PowerApdex({ target: 100, targt: 100 })).toThrow(/unknown option/);
    });
  });

  describe('record()', () => {
    it('files +Infinity as frustrated, which is where a timeout belongs', () => {
      // The one non-finite value `record()` accepts. A request that never
      // completed is not a latency, but a caller who has decided to treat a
      // timeout as "as slow as possible" needs somewhere to put it, and
      // frustrated is that class.
      const apdex = new PowerApdex({ target: 100 });
      apdex.record(Infinity);
      expect(apdex.stats()).toMatchObject({ satisfied: 0, tolerating: 0, frustrated: 1 });
      expect(apdex.score()).toBe(0);
    });

    it('refuses a latency it cannot read', () => {
      // `NaN` and a negative are not slow requests. Filing either as one would
      // move the score for a reason that has nothing to do with the service.
      const apdex = new PowerApdex({ target: 100 });
      expect(() => apdex.record(NaN)).toThrow(TypeError);
      expect(() => apdex.record(-1)).toThrow(TypeError);
      expect(() => apdex.record('soon')).toThrow(TypeError);
      expect(apdex.total).toBe(0);
    });

    it('returns this, so a stream of records chains', () => {
      const apdex = new PowerApdex({ target: 100 });
      expect(apdex.record(1).record(2).record(3)).toBe(apdex);
      expect(apdex.total).toBe(3);
    });
  });

  describe('the case that decided the implementation', () => {
    it('scores a distribution concentrated at the threshold exactly', () => {
      // **This is the assertion that dies if PowerApdex is ever reimplemented
      // over a PowerHistogram.** 90% of the mass just below the target and 10%
      // just above, both inside one DDSketch bucket: `bench/claims.js apdex`
      // measures the derived score at 0.625 against a truth of 0.950, because a
      // single bucket cannot be split 90/10 by an interpolation that assumes
      // the mass is even in log space. Three integers do not have that problem.
      const apdex = new PowerApdex({ target: 100 });
      for (let i = 0; i < 1000; i++) apdex.record(i < 900 ? 99.5 : 100.5);
      expect(apdex.score()).toBe(0.95);
      // 100.5 is *tolerating*, not frustrated — it is inside 4T. The score is
      // still 0.95, because a tolerating sample is worth half a satisfied one
      // and 100 of them are worth 50: (900 + 50) / 1000.
      expect(apdex.stats()).toMatchObject({ satisfied: 900, tolerating: 100, frustrated: 0 });
    });

    it('stays exact where a rank query would drift, at every accuracy', () => {
      // The bench sweeps `relativeAccuracy` and the error is not monotonic in
      // it — 0.665 points at 0.05, 324 at 0.01, 158 at 0.001 — because the
      // error depends on where the threshold falls inside the bucket. There is
      // no accuracy setting to tune, which is the point: the counters are exact
      // at all of them.
      const apdex = new PowerApdex({ target: 100 });
      for (let i = 0; i < 100; i++) apdex.record(i < 90 ? 99.5 : 100.5);
      expect(apdex.score()).toBe(0.95);
    });
  });

  describe('merge()', () => {
    it('adds the counts exactly, so per-worker scorers aggregate', () => {
      const a = new PowerApdex({ target: 100 });
      const b = new PowerApdex({ target: 100 });
      a.record(10); // satisfied
      a.record(500); // frustrated — 500 is above 4T
      b.record(20); // satisfied
      b.record(200); // tolerating
      b.record(900); // frustrated
      a.merge(b);
      expect(a.stats()).toMatchObject({ satisfied: 2, tolerating: 1, frustrated: 2, total: 5 });
      expect(a.score()).toBeCloseTo((2 + 0.5) / 5, 12);
    });

    it('refuses a scorer configured against different thresholds', () => {
      // Counts taken against different thresholds are not the same
      // measurement, and adding them produces a number that means nothing.
      // Same rule as `PowerHistogram.merge()` and its `relativeAccuracy`.
      const a = new PowerApdex({ target: 100 });
      const b = new PowerApdex({ target: 200 });
      expect(() => a.merge(b)).toThrow(/threshold mismatch/);
      const c = new PowerApdex({ target: 100, tolerance: 1000 });
      expect(() => a.merge(c)).toThrow(/threshold mismatch/);
    });

    it('refuses anything that is not a PowerApdex', () => {
      const a = new PowerApdex({ target: 100 });
      expect(() => a.merge({ satisfied: 1 })).toThrow(TypeError);
      expect(() => a.merge(null)).toThrow(TypeError);
    });
  });

  describe('reset and dispose', () => {
    it('reset() zeroes the counts and keeps the thresholds', () => {
      // The thresholds are configuration, not state. A reset that dropped them
      // would leave a scorer that cannot be used without reconstructing it.
      const apdex = new PowerApdex({ target: 100, tolerance: 500 });
      apdex.record(10);
      apdex.reset();
      expect(apdex.stats()).toMatchObject({
        target: 100,
        tolerance: 500,
        satisfied: 0,
        total: 0,
      });
      expect(apdex.score()).toBeUndefined();
      // and it still works afterwards
      apdex.record(10);
      expect(apdex.score()).toBe(1);
    });

    it('clear() is the same act as reset()', () => {
      const apdex = new PowerApdex({ target: 100 });
      apdex.record(10);
      apdex.clear();
      expect(apdex.total).toBe(0);
    });

    it('dispose() is a state reset, not a teardown', () => {
      // Owns no timer and no listener registry — it is three integers — so
      // there is nothing to cancel. The interface exists for `using` parity.
      const apdex = new PowerApdex({ target: 100 });
      apdex.record(10);
      apdex.dispose();
      expect(apdex.total).toBe(0);
      expect(apdex.target).toBe(100);
      // Idempotent, and the second call does not throw on the detached receipt.
      expect(() => apdex.dispose()).not.toThrow();
    });

    it('takes part in using and await using teardown', () => {
      const apdex = new PowerApdex({ target: 100 });
      apdex.record(10);
      apdex[Symbol.dispose]();
      expect(apdex.total).toBe(0);
    });

    it('detaches from metrics on dispose', async () => {
      const collector = new MetricsCollector();
      const apdex = new PowerApdex({ target: 100, observability: collector });
      apdex.record(10);
      expect(collector.snapshot().series['apdex.satisfied']).toBe(1);
      await apdex[Symbol.asyncDispose]();
      // The key disappears rather than freezing at its last value, which would
      // read as a scorer that stopped moving.
      expect(collector.snapshot().series['apdex.satisfied']).toBeUndefined();
      expect(collector.names()).toEqual([]);
    });
  });

  describe('observability', () => {
    it('registers in the shared collector and reports the thresholds', () => {
      // The thresholds are in the series deliberately: a score is meaningless
      // without the line it was measured against, and a dashboard that has to
      // remember which threshold produced a series will eventually plot two
      // different SLOs on one axis.
      const apdex = new PowerApdex({ target: 100, observability: true });
      apdex.record(50);
      apdex.record(900);
      const series = defaultMetrics.snapshot().series;
      expect(series['apdex.target']).toBe(100);
      expect(series['apdex.tolerance']).toBe(400);
      expect(series['apdex.satisfied']).toBe(1);
      expect(series['apdex.frustrated']).toBe(1);
      expect(series['apdex.score']).toBe(0.5);
      apdex.dispose();
    });

    it('reports an absent score as null rather than dropping the key', () => {
      // `toSeries` maps a nullish field to `null` so an unmeasured scorer is
      // distinguishable from one that scored zero.
      const apdex = new PowerApdex({ target: 100, observability: true });
      expect(defaultMetrics.snapshot().series['apdex.score']).toBeNull();
      apdex.dispose();
    });

    it('answers to getStats(), the compatibility alias', () => {
      const apdex = new PowerApdex({ target: 100 });
      apdex.record(10);
      expect(apdex.getStats()).toEqual(apdex.stats());
    });
  });
});
