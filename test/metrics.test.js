import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The completeness guard below reads the helpers to count who attaches, so it
// needs the directory rather than a fixed list of helpers.
const HELPERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'helpers');
import {
  MetricsCollector,
  toSeries,
  METRICS_VERSION,
  OBSERVATION_VERSION,
  defaultMetrics,
  attach,
  createObservation,
  diffObservation,
  formatPrometheus,
} from '../src/helpers/metrics.js';
import { PowerCache } from '../src/helpers/powerCache.js';
import { PowerGCRA } from '../src/helpers/powerGCRA.js';
import { PowerPool } from '../src/helpers/powerPool.js';
import { PowerBulkhead } from '../src/helpers/powerBulkhead.js';
import { PowerRetryBudget } from '../src/helpers/powerRetry.js';
import { PowerEventLoopMonitor } from '../src/helpers/powerEventLoopMonitor.js';
import { PowerSocketAdapter } from '../src/helpers/powerSocketAdapter.js';
import { PowerRealtimeHub } from '../src/helpers/powerRealtimeHub.js';
import { PowerWebSocketClient } from '../src/helpers/powerWebSocketClient.js';
import { PowerWebTransportClient } from '../src/helpers/powerWebTransportClient.js';
import { PowerRTCChannel } from '../src/helpers/powerRTCChannel.js';
import { PowerThrottle } from '../src/helpers/powerThrottle.js';
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';
import { PowerRateLimit } from '../src/helpers/powerRateLimit.js';
import { PowerMessagePort } from '../src/helpers/powerMessagePort.js';
import { PowerDatagramChannel } from '../src/helpers/powerDatagramChannel.js';
import { PowerSequencer } from '../src/helpers/powerSequencer.js';
import { PowerFlowControl } from '../src/helpers/powerFlowControl.js';
import { PowerApdex } from '../src/helpers/powerApdex.js';

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
  describe('observations', () => {
    it('records sampling metadata without changing the series values', () => {
      const observation = createObservation(
        { 'pool.queue': 4 },
        {
          observedAt: 100,
          samples: 8,
          windowMs: 500,
          fresh: false,
          confidence: 0.75,
        }
      );
      expect(observation).toEqual({
        version: OBSERVATION_VERSION,
        observedAt: 100,
        samples: 8,
        windowMs: 500,
        fresh: false,
        confidence: 0.75,
        series: { 'pool.queue': 4 },
      });
    });

    it('rejects confidence outside the evidence range', () => {
      expect(() => createObservation({}, { confidence: 1.1 })).toThrow(TypeError);
      expect(() => createObservation({}, { confidence: -0.1 })).toThrow(TypeError);
    });

    it('returns deltas only when both observations contain finite numbers', () => {
      const previous = createObservation({ a: 2, b: null, c: 'old' });
      const current = createObservation({ a: 7, b: 3, c: 'new', d: 1 });
      expect(diffObservation(current, previous)).toEqual({ a: 5, b: null, c: null, d: null });
    });
  });
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

describe('formatPrometheus', () => {
  it('formats scalar metrics with escaped labels', () => {
    expect(
      formatPrometheus([
        {
          name: 'jobs_completed_total',
          type: 'counter',
          help: 'Completed jobs',
          value: 3,
          labels: { app: 'a"b' },
        },
      ])
    ).toBe(
      '# HELP jobs_completed_total Completed jobs\n# TYPE jobs_completed_total counter\njobs_completed_total{app="a\\"b"} 3\n'
    );
  });

  it('formats explicit cumulative histogram buckets and rejects ambiguous values', () => {
    expect(
      formatPrometheus([
        {
          name: 'job_duration_seconds',
          type: 'histogram',
          help: 'Job duration',
          value: {
            buckets: [
              { le: 1, value: 2 },
              { le: 5, value: 3 },
            ],
            count: 3,
            sum: 4,
          },
        },
      ])
    ).toContain('job_duration_seconds_bucket{le="+Inf"} 3');
    expect(() =>
      formatPrometheus([{ name: 'bad-name', type: 'gauge', help: 'bad', value: 1 }])
    ).toThrow(/valid metric name/);
    // D1a: the message names the metric and what it actually got, rather than
    // listing all three requirements. The old text was `histogram value needs
    // buckets, count, and sum`, which told a caller who supplied two of the
    // three to check the one that was fine.
    expect(() => formatPrometheus([{ name: 'h', type: 'histogram', help: 'h', value: 1 }])).toThrow(
      /histogram `h` needs an object/
    );
    // And it distinguishes the three fields, so the fix is actionable rather
    // than a list to work through.
    expect(() =>
      formatPrometheus([
        { name: 'h', type: 'histogram', help: 'h', value: { buckets: [], count: 1, sum: 'x' } },
      ])
    ).toThrow(/`sum` as a finite number/);
    expect(() =>
      formatPrometheus([
        { name: 'h', type: 'histogram', help: 'h', value: { buckets: 'no', count: 1, sum: 1 } },
      ])
    ).toThrow(/`buckets` as an array/);
  });

  it('names the offending label rather than saying "name or value"', () => {
    // D1a. The two failure modes need different fixes, so "or" was the wrong
    // word even with one label — and with twenty it meant bisecting your own
    // input.
    expect(() =>
      formatPrometheus([
        { name: 'm', type: 'gauge', help: 'h', value: 1, labels: { 'bad-key': 1 } },
      ])
    ).toThrow(/label name `bad-key` is not a valid Prometheus label/);
    expect(() =>
      formatPrometheus([
        { name: 'm', type: 'gauge', help: 'h', value: 1, labels: { ok: 'line\nbreak' } },
      ])
    ).toThrow(/label `ok` has a value containing a newline/);
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

describe('observability: true on the helpers', () => {
  // FEAT-007 part two. The point of the "all of them or none" rule is that
  // `observability: true` means the same thing everywhere, so this is a test
  // over the whole set rather than per helper: a helper that drifts out of the
  // agreement fails here rather than in a dashboard.
  //
  // **Every one of them, counted from the source rather than from this
  // list** — `rg "attach\(this, '" src/helpers/*.js` is what the rule means, and
  // the assertion below re-checks that count so the list cannot quietly fall
  // behind a tenth helper. The previous version of this file was titled "all
  // or none" and tested four; five were untested, and three of the five
  // needed a real constructor argument rather than an empty options bag, which
  // is a good part of why they were skipped.
  const HELPERS = [
    ['PowerCache', () => new PowerCache({ observability: true }), 'cache'],
    ['PowerBulkhead', () => new PowerBulkhead({ observability: true }), 'bulkhead'],
    [
      'PowerDatagramChannel',
      () =>
        new PowerDatagramChannel(/** @type {any} */ ({ send: () => {}, readyState: 'open' }), {
          observability: true,
        }),
      'datagramChannel',
    ],
    ['PowerGCRA', () => new PowerGCRA({ rate: 1, per: 1000, observability: true }), 'gcra'],
    [
      'PowerRetryBudget',
      () => new PowerRetryBudget({ ratio: 0.2, observability: true }),
      'retryBudget',
    ],
    ['PowerEventLoopMonitor', () => new PowerEventLoopMonitor({ observability: true }), 'loop'],
    [
      'PowerMessagePort',
      () =>
        new PowerMessagePort(
          /** @type {any} */ ({
            postMessage: () => {},
            close: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => true,
          }),
          { observability: true }
        ),
      'messagePort',
    ],
    // A socket the adapter can identify. `{}` throws by design — the adapter
    // refuses a socket it cannot classify rather than guessing.
    [
      'PowerSocketAdapter',
      () =>
        new PowerSocketAdapter(
          /** @type {any} */ ({ on: () => {}, off: () => {}, send: () => {}, close: () => {} }),
          { observability: true }
        ),
      'socket',
    ],
    [
      'PowerRealtimeHub',
      () => new PowerRealtimeHub({ send: () => {}, observability: true }),
      'hub',
    ],
    [
      'PowerWebSocketClient',
      () => new PowerWebSocketClient({ url: 'ws://test/', observability: true }),
      'ws',
    ],
    [
      'PowerWebTransportClient',
      () =>
        new PowerWebTransportClient({
          url: 'https://example.test/feed',
          WebTransportImpl: class {
            constructor() {
              return {
                ready: Promise.resolve(),
                closed: Promise.resolve(),
                createBidirectionalStream() {
                  return {
                    readable: new ReadableStream({
                      start(controller) {
                        controller.enqueue(new Uint8Array());
                      },
                    }),
                    writable: new WritableStream({
                      write() {},
                    }),
                  };
                },
                close() {},
              };
            }
          },
          observability: true,
        }),
      'wt',
    ],
    // A factory source needs no preload, which is what makes a pool testable
    // without a real worker file.
    [
      'PowerPool',
      () =>
        new PowerPool('data:text/javascript,export default function(){}', {
          observability: true,
        }),
      'pool',
    ],
    // RT-017. Needs a live data channel rather than a URL, so the factory is a
    // minimal EventTarget-shaped double — the class only reads `readyState`,
    // `addEventListener`, `send` and `close`, and `metrics` is opt-in, so the
    // double exists to satisfy the constructor rather than to exercise the
    // transport. Everything else about this helper is tested in
    // `test/powerRTCChannel*.test.js`.
    [
      'PowerRTCChannel',
      () => new PowerRTCChannel(metricsDataChannel(), { observability: true }),
      'rtc',
    ],
    // The three limiters, which took `observability` last (RES-034). Each needs a
    // real argument rather than an empty options bag — the same reason five of
    // the earlier entries were skipped when this list was first written, and the
    // reason it is worth stating that a `it.each` row is cheap but a
    // *constructible* one is not.
    ['PowerThrottle', () => new PowerThrottle({ capacity: 10, observability: true }), 'throttle'],
    [
      'PowerSlidingWindow',
      () => new PowerSlidingWindow({ capacity: 10, observability: true }),
      'slidingWindow',
    ],
    [
      'PowerRateLimit',
      () => new PowerRateLimit([new PowerThrottle({ capacity: 10 })], { observability: true }),
      'rateLimit',
    ],
    // S1d. Needs no constructor argument at all — it is a pure state machine —
    // which is the cheapest row in this list and the reason it was not one of
    // the five that needed a real argument when the list was first written.
    ['PowerSequencer', () => new PowerSequencer({ observability: true }), 'sequencer'],
    // F1a. Needs a capacity, because a bucket of 0 is inert.
    [
      'PowerFlowControl',
      () => new PowerFlowControl({ capacity: 10, observability: true }),
      'flowControl',
    ],
    // ADR-0014. Needs a `target`, because there is no default and the
    // constructor refuses to invent one — which is the same reason this row
    // could not be one of the "no constructor argument at all" cheap ones.
    ['PowerApdex', () => new PowerApdex({ target: 100, observability: true }), 'apdex'],
  ];

  // Every prefix this describe block mutates, torn down after each test.
  //
  // The row claimed this "removes a latent order dependency" because the
  // singleton is mutated with no teardown, leaving `bulkhead` and
  // `retryBudget` registered for the rest of the file. **That claim was wrong,
  // and it is worth recording why**: every helper in the list already detaches
  // on `dispose()`, which each case calls, so the singleton was clean between
  // tests before this hook existed. Removing the hook and restoring the
  // `before`-count assertion both leave the suite green — verified, not
  // assumed.
  //
  // So this is defensive isolation, not a fix: it means a case that fails
  // *before* its own `dispose()` cannot leave a registration behind for the
  // cases after it. That is worth having in a file whose whole subject is a
  // shared mutable singleton, and it is claimed as nothing more than that.
  /**
   * The bare minimum `PowerRTCChannel` reads: a string `readyState`, an
   * `EventTarget` pair, and the two transport methods.
   *
   * Kept to five members on purpose. A richer double would make this test depend
   * on behaviour it is not about — the point of the case is that `attach` fires
   * and that `dispose()` unregisters it, and anything more would be a second
   * subject to keep correct.
   */
  const metricsDataChannel = () => ({
    readyState: 'open',
    send: () => {},
    close: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  });

  const PREFIXES = HELPERS.map((h) => h[2]);

  afterEach(() => {
    for (const prefix of PREFIXES) defaultMetrics.unregister(prefix);
  });

  it.each(HELPERS)('%s registers into the shared collector', (_name, make, prefix) => {
    defaultMetrics.unregister(prefix);
    const helper = make();
    expect(defaultMetrics.names()).toContain(prefix);
    const { series } = defaultMetrics.snapshot();
    expect(Object.keys(series).some((k) => k.startsWith(`${prefix}.`))).toBe(true);
    helper.dispose?.();
  });

  it.each(HELPERS)('%s stops being sampled once torn down', (_name, make, prefix) => {
    // The other half of the contract, and the half that is silent when wrong:
    // a registration that outlives its helper is a series that looks live and
    // is not. `terminate()` on a pool still answers `getStats()`, so nothing
    // fails visibly.
    const helper = make();
    expect(defaultMetrics.names()).toContain(prefix);
    // `terminate()` before `dispose()` on purpose, because the pool's real
    // teardown is `terminate()` and it must detach on its own.
    helper.terminate?.();
    helper.dispose?.();
    expect(defaultMetrics.names()).not.toContain(prefix);
  });

  it.each(HELPERS)(
    '%s detaches on the async path too, not only on dispose()',
    async (_name, make, prefix) => {
      // B2's actual brief is the **asyncDispose** path, and the two cases above
      // only exercise `dispose()`. A helper whose `asyncDispose` forwarded to
      // something other than `dispose()` — `close()`, say — would detach on the
      // sync path and stay registered on the async one, which is the half of
      // the contract that is silent when wrong.
      //
      // `PowerGCRA` and `PowerRateLimit` had no `asyncDispose` at all while
      // their sibling limiters did, so `await using` on them did not take part
      // in teardown. This case is what makes that class of gap fail loudly
      // rather than passing by never being called.
      defaultMetrics.unregister(prefix);
      const helper = make();
      expect(defaultMetrics.names()).toContain(prefix);

      await helper[Symbol.asyncDispose]();

      expect(defaultMetrics.names()).not.toContain(prefix);
    }
  );

  it('covers every helper that attaches, and no others', () => {
    // **This is the guard the "all of them or none" rule actually needed**, and the
    // first version of it did not work: it asserted `prefixes.size ===
    // HELPERS.length` and that nothing was left registered, which is trivially
    // true and stays true when five entries are deleted from the list. Removing
    // five helpers from this `it.each` runs five fewer cases and nothing else,
    // so the test passed. That is the exact failure mode of the file it was
    // written to fix — titled "all nine or none", testing four — reproduced
    // inside the test meant to prevent it.
    //
    // So the count is taken from the source. `attach(this, '<prefix>'` in
    // `src/helpers/` is what makes a helper register, which is the thing the
    // guide's guarantee is about, and reading it here means a tenth helper
    // added tomorrow fails this test rather than being silently left untested.
    const source = (() => {
      // Recurse into subdirectories: `powerCache.js` was split into `cache/`, and
      // `attach(this, 'cache'` lives in `cache/core.js` — a top-level read alone
      // would miss it and report 14 helpers against a 15-entry list.
      const collect = (dir) => {
        const out = [];
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) out.push(...collect(full));
          else if (entry.name.endsWith('.js')) out.push(readFileSync(full, 'utf8'));
        }
        return out;
      };
      return collect(HELPERS_DIR).join('\n');
    })();

    const attached = [...source.matchAll(/attach\(this,\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
    expect(attached.length).toBeGreaterThan(0); // the regex must still find something
    expect([...attached].sort()).toEqual([...PREFIXES].sort());
    // And no duplicates: two helpers sharing a prefix would make the second
    // silently replace the first's series, and `unregister(prefix)` in the
    // teardown would then remove whichever registered last.
    expect(new Set(PREFIXES).size).toBe(PREFIXES.length);
  });

  it('registers nothing by default', () => {
    // The cost of the feature when nobody asks for it has to be zero, and
    // "zero" means no series appears — not merely that the numbers are small.
    //
    // The assertion is against an exact 0 rather than a `before` count. That
    // was changed deliberately: with a `before` count this test passes whether
    // or not earlier tests leaked registrations, which is the "before" the
    // previous version compared against.
    expect(defaultMetrics.names().length).toBe(0);
    new PowerCache();
    expect(defaultMetrics.names().length).toBe(0);
  });

  it('rejects a value that is neither true nor a collector', () => {
    // This used to be "ignores a value that is not a collector", and the
    // leniency was the bug rather than the virtue. `'yes'` is truthy, is not
    // `true`, and has no `register`, so it registered nothing and reported
    // nothing: a caller who asked to be measured was silently not measured, and
    // would find out from a dashboard that looked plausible.
    //
    // The same reasoning that made every other option in this library throw on a
    // wrong value applies here, and a falsy value is still the way to say "off".
    for (const bad of ['yes', 1, {}, [], Symbol('x')]) {
      expect(() => new PowerCache({ observability: bad }), String(bad)).toThrow(
        /`observability` must be `true` or a MetricsCollector/
      );
    }
    // Falsy stays inert, because "off" is a legitimate answer.
    expect(defaultMetrics.names()).not.toContain('cache');
  });

  it('a helper with no stats() registers nothing rather than an empty series', () => {
    // An empty series would read as "this helper is idle", which is a different
    // and wrong claim.
    //
    // Asserted against `attach()` directly rather than through a constructor,
    // because every class that accepts `observability` now has counters of its
    // own — `PowerRetryBudget` included, which is what this used to build. The
    // branch is still reachable from the library's own side, and this is the
    // only way in.
    const statsless = { notAHelper: true };
    expect(attach(statsless, 'statsless', { observability: true })).toBeNull();
    expect(defaultMetrics.names()).not.toContain('statsless');
  });

  it('a disposed helper stops being sampled', () => {
    const cache = new PowerCache({ observability: true });
    expect(defaultMetrics.names()).toContain('cache');
    cache.dispose();
    // Without this, a collector holds a closure over a dead object forever and
    // keeps reporting it — which is a series that looks live and is not.
    expect(defaultMetrics.names()).not.toContain('cache');
  });

  it('detach is safe on a helper that never attached', () => {
    const cache = new PowerCache();
    expect(() => cache.dispose()).not.toThrow();
  });
});
