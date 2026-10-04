import { describe, it, expect } from 'vitest';
import { PowerThrottle } from '../src/helpers/powerThrottle.js';
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';
import { PowerRateLimit } from '../src/helpers/powerRateLimit.js';
import { MetricsCollector, attach, detach, toSeries } from '../src/helpers/metrics.js';

/**
 * RES-034, `observability` half: the three limiters report themselves.
 *
 * ## Why this file exists separately from `test/metrics.test.js`
 *
 * That file proves the *mechanism* — a helper registers, produces a series, and
 * stops being sampled once torn down — and its completeness guard now counts
 * these three. It cannot check what the series says, because a wrong number
 * still registers and still stops on dispose. Everything here is about the
 * **content**, and specifically about two claims made in the source comments that
 * would otherwise be untested prose:
 *
 * 1. **`PowerThrottle.stats()` refills, and `PowerSlidingWindow.stats()` prunes,
 *    before reporting.** Both stores are only ever advanced by the operation that
 *    also *reads* them, so a snapshot taken after a quiet spell reports an
 *    exhausted bucket and a saturated window that will both happily admit the
 *    next request. That is the wrong direction to be wrong in: a dashboard
 *    showing "nothing available" sends someone to debug a limiter that is
 *    working.
 * 2. **`PowerRateLimit.stats().available` is `null` when `keyFn` is set**, rather
 *    than one arbitrary tenant's allowance presented as the composition's.
 *
 * ## Clocks, not durations
 *
 * Every assertion here runs on an injected clock. Nothing sleeps and nothing
 * measures elapsed time: the harness reports a 28.61 % median min/max spread, so a
 * duration-shaped assertion about refills would be a coin flip, while
 * "advance the clock past one window and the count is zero" is exact.
 */
describe('limiter observability (RES-034)', () => {
  describe('PowerThrottle.stats() reports the bucket as of now', () => {
    it('refills before reporting, so a recovered bucket is not shown as exhausted', () => {
      let clock = 0;
      // 10 tokens/second, capacity 5. One second of silence earns the whole
      // bucket back.
      const t = new PowerThrottle({ capacity: 5, refillRate: 10, now: () => clock });
      expect(t.tryConsume(5)).toBe(true);
      expect(t.tokens).toBe(0);

      // The stored field is still 0 — nothing advances it but a read.
      expect(t.tokens).toBe(0);
      clock = 1000;
      const { tokens, capacity, refillRate } = t.stats();
      expect(capacity).toBe(5);
      expect(refillRate).toBe(10);
      // **This is the assertion that dies if the refill is removed.**
      expect(tokens).toBe(5);
    });

    it('reports exactly the three documented fields, and no counters', () => {
      // Pinned because it is a decision, not an oversight: allow/refuse counters
      // would mean incrementing a field on `tryConsume`, the hot synchronous
      // path, for a feature that is off by default. If someone adds counters,
      // this fails and they have to argue for the hot-path cost.
      const t = new PowerThrottle({ capacity: 3, refillRate: 1 });
      t.tryConsume();
      expect(Object.keys(t.stats()).sort()).toEqual(['capacity', 'refillRate', 'tokens']);
      t.dispose();
    });
  });

  describe('PowerSlidingWindow.stats() reports the window as of now', () => {
    it('prunes expired timestamps, so a quiet window does not look saturated', () => {
      let clock = 0;
      const w = new PowerSlidingWindow({ capacity: 3, windowMs: 1000, now: () => clock });
      expect(w.tryConsume(3)).toBe(true);
      expect(w.stats().used).toBe(3);

      // Every recorded timestamp is now older than the window. Nothing evicts
      // them except a prune, and this is the prune.
      clock = 2000;
      const { used, available, capacity, windowMs } = w.stats();
      expect(used).toBe(0);
      expect(available).toBe(3);
      expect(capacity).toBe(3);
      expect(windowMs).toBe(1000);
    });

    it('keeps a timestamp that is still inside the window', () => {
      // The complement of the test above, and the one that would fail if `stats()`
      // cleared the queue instead of pruning it — which would make a busy window
      // look empty and let it admit a burst past its limit.
      let clock = 0;
      const w = new PowerSlidingWindow({ capacity: 3, windowMs: 1000, now: () => clock });
      w.tryConsume(2);
      clock = 500;
      expect(w.stats().used).toBe(2);
      expect(w.stats().available).toBe(1);
    });
  });

  describe('PowerRateLimit.stats() refuses to invent a number for a keyed composer', () => {
    const keyed = () =>
      new PowerRateLimit([() => new PowerThrottle({ capacity: 5, refillRate: 0 })], {
        keyFn: (ctx) => String(ctx),
        buckets: 4,
      });

    it('reports available as null, not as the shared slot’s headroom', () => {
      const limit = keyed();
      limit.tryConsume(1, { context: 'a' });
      limit.tryConsume(1, { context: 'b' });
      const stats = limit.stats();
      // `available()` would happily report a number here by measuring the shared
      // default slot. That number belongs to one arbitrary tenant.
      expect(stats.available).toBeNull();
      expect(stats.keyed).toBe(true);
      expect(stats.buckets).toBe(4);
      // Two keys, two slots — unless they collide, which three-into-four can. Here
      // the count is what the composer actually built rather than what two keys
      // would ideally deserve.
      expect(stats.builtSlots).toBe(limit._slots.filter(Boolean).length);
      expect(stats.builtSlots).toBeGreaterThan(0);
      limit.dispose();
    });

    it('reports a real number for an unkeyed composer', () => {
      // The counterpart: `null` means "no single answer", so an unkeyed composer
      // that *does* have one must not report null.
      const limit = new PowerRateLimit([new PowerThrottle({ capacity: 5, refillRate: 0 })]);
      expect(limit.stats().available).toBe(5);
      expect(limit.stats().keyed).toBe(false);
      expect(limit.stats().buckets).toBe(0);
      expect(limit.stats().legs).toBe(1);
      limit.dispose();
    });

    it('survives a JSON round-trip, because null does', () => {
      // The `tat: null` lesson from `PowerGCRA.stats()`: `-Infinity` does not
      // survive `JSON.stringify`, so a snapshot claiming `number` was only true in
      // memory. `null` is the value chosen so this holds.
      const limit = keyed();
      limit.tryConsume(1, { context: 'a' });
      expect(JSON.parse(JSON.stringify(limit.stats())).available).toBeNull();
      limit.dispose();
    });
  });

  describe('the collector contract', () => {
    // Each helper is registered against a collector **of its own** rather than the
    // shared singleton, because the shared one is process-wide mutable state and
    // this file's subject is the series *content*. Registration against the shared
    // collector is already covered exhaustively — and including the prefix check —
    // by `test/metrics.test.js`, whose completeness guard counts these three from
    // the source. Duplicating it here would be a second place to update and a
    // second way to be wrong.
    const CASES = [
      [
        'throttle',
        'throttle.tokens',
        () => new PowerThrottle({ capacity: 4, observability: true }),
      ],
      [
        'slidingWindow',
        'slidingWindow.used',
        () => new PowerSlidingWindow({ capacity: 4, observability: true }),
      ],
      [
        'rateLimit',
        'rateLimit.legs',
        () => new PowerRateLimit([new PowerThrottle({ capacity: 4 })], { observability: true }),
      ],
    ];

    it.each(CASES)('%s registers and flattens its stats into the series', (prefix, key, make) => {
      const collector = new MetricsCollector();
      // A collector **of its own**, so nothing here touches the process-wide one.
      const helper = make();
      // Re-attach against the local collector: the helper was constructed with
      // `observability: true`, which registers with the shared singleton, and this
      // test is about the flattened shape rather than about which collector won.
      detach(helper._metrics);
      helper._metrics = attach(helper, prefix, { observability: collector });

      expect(collector.names()).toContain(prefix);
      const { series, sources } = collector.snapshot();
      expect(sources).toContain(prefix);
      expect(series[key]).toBeTypeOf('number');
      helper.dispose();
    });

    it('detaches on dispose, so a torn-down limiter stops being sampled', () => {
      // The silent failure this guards: `dispose()` exists and `stats()` still
      // answers afterwards, so a missed detach produces a series that looks live
      // and is not — with no error anywhere.
      for (const [prefix, , make] of CASES) {
        const collector = new MetricsCollector();
        const helper = make();
        detach(helper._metrics);
        helper._metrics = attach(helper, prefix, { observability: collector });
        expect(collector.names()).toContain(prefix);
        helper.dispose();
        expect(collector.names(), `${prefix} after dispose`).not.toContain(prefix);
      }
    });

    it('keeps a null series value rather than dropping the key', () => {
      // The `PowerGCRA` `tat: null` precedent, and it is load-bearing in the other
      // direction: dropping the key would make "this composer has no single
      // availability" indistinguishable from "this field was never measured",
      // which are different claims and only one of them is true.
      const limit = new PowerRateLimit([() => new PowerThrottle({ capacity: 4 })], {
        keyFn: (ctx) => String(ctx),
        observability: true,
      });
      const flat = toSeries('rateLimit', limit.stats());
      // Prefixed, because that is what `snapshot()` publishes and what a consumer
      // reads — an unprefixed key here would mean asserting a shape nobody sees.
      expect('rateLimit.available' in flat).toBe(true);
      expect(flat['rateLimit.available']).toBeNull();
      limit.dispose();
    });

    it('registers nothing when observability is off', () => {
      // The cost of the feature when nobody asks for it has to be zero, and
      // "zero" means no receipt — not merely a small one.
      expect(new PowerThrottle({ capacity: 4 })._metrics).toBeNull();
      expect(new PowerSlidingWindow({ capacity: 4 })._metrics).toBeNull();
      expect(new PowerRateLimit([new PowerThrottle({ capacity: 4 })])._metrics).toBeNull();
    });

    it('rejects a value that is neither true nor a collector', () => {
      // Same reasoning as every other option in this library: a caller who asked
      // to be measured and silently was not would find out from a dashboard that
      // looked plausible.
      for (const bad of ['yes', 1, {}, []]) {
        expect(() => new PowerThrottle({ capacity: 4, observability: bad }), String(bad)).toThrow(
          /`observability` must be `true` or a MetricsCollector/
        );
      }
    });
  });
});
