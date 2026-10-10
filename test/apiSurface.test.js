import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import * as index from '../src/index.js';
import * as constants from '../src/helpers/constants.js';

/**
 * TEST-007 — API surface snapshot and ESM ↔ UMD export parity.
 *
 * The 2.0 work added a lot of public surface: a `maxQueueLength` and
 * `maxDrainWaiters` option, `expiredCount` and `purge()`, seven new constants,
 * eight `reset`/`clear` aliases, and one *removal*
 * (`PowerCache.hasEqualWithSeen`). None of those are individually large, and
 * that is exactly why they need a guard. Every one is a change to the
 * documented contract, and a contract that is only checked by hand is a
 * contract that drifts.
 *
 * The specific accident this test is here to prevent already happened once
 * during the 2.0 work: a new constant was written as `DEFAULT_QUEUE_CAPACITY`,
 * which already existed in `constants.js` meaning something entirely different
 * (a backpressure backlog of 100, not a `PowerQueue` preallocation of 16). It
 * was caught only because a name collision with compatible-looking semantics
 * would have been silent. A snapshot makes that class of accident loud.
 *
 * Three things are checked, in increasing order of value:
 *
 *  1. **The named export list is pinned.** New public API is then a deliberate
 *     edit to this file rather than a side effect of adding a helper.
 *  2. **Every `package.json` subpath resolves, and its named exports match the
 *     module it points at.** 35 subpaths exist; the pre-existing
 *     `test/packageExports.test.js` checked 3.
 *  3. **ESM/UMD export parity — NOT IMPLEMENTED, and deliberately so.** See the
 *     note at the bottom of this file: two separate hand-written entry points to
 *     one library do drift silently, but no check written inside this file could
     be demonstrated to fail, so none is claimed.
 */

/** @returns {Record<string, unknown>} package.json parsed. */
function pkg() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
}

/** The named exports of the package root, sorted. */
const ROOT_EXPORTS = Object.keys(index).sort();

describe('API surface', () => {
  it('pins the package-root export list', () => {
    // Adding to this list is the point - it is a review checkpoint, not a
    // chore. Keep it sorted so a diff shows one added name, not a reshuffle.
    expect(ROOT_EXPORTS).toEqual(
      [
        'CODECS',
        'HEADER_BYTES',
        'MESSAGE_PROTOCOL_VERSION',
        'PowerAdaptiveProposal',
        'PowerBackpressure',
        'PowerBatch',
        'PowerBrownout',
        'PowerBulkhead',
        'PowerCache',
        'PowerChunker',
        'PowerCircuit',
        'PowerCron',
        'PowerCrossLock',
        'PowerDatagramChannel',
        'PowerDeadline',
        'PowerDefer',
        'PowerEventBus',
        'PowerFlowControl',
        'PowerEventLoopMonitor',
        'PowerGCRA',
        'PowerHeartbeat',
        'PowerHistogram',
        'PowerApdex',
        'PowerLatch',
        'PowerLogger',
        'PowerMemoizer',
        'PowerMessageCodec',
        'PowerMessagePort',
        'PowerObserver',
        'PowerPermitGate',
        'PowerPool',
        'PowerQueue',
        'PowerDeduplication',
        'PowerPriorityQueue',
        'PowerRateLimit',
        'PowerRealtimeHub',
        'PowerRetry',
        'PowerRetryBudget',
        'PowerScheduler',
        'PowerSemaphore',
        'PowerSequencer',
        'PowerServo',
        'PowerSlidingWindow',
        'PowerSubscriberSet',
        'PowerTTLMap',
        'MetricsCollector',
        'OBSERVATION_VERSION',
        // Re-exported so the one-liner both `guides/metrics.md` and the
        // `attach()` JSDoc show can be followed literally. Without it,
        // `defaultMetrics` is reachable only via the `/metrics` subpath, which
        // neither of those two places mentions (GATE-009).
        'defaultMetrics',
        'toSeries',
        'METRICS_VERSION',
        'PowerThrottle',
        'PowerTimedCache',
        'PowerWebSocketClient',
        'PowerWebTransportClient',
        'PowerSocketAdapter',
        'PowerRTCChannel',
        'detectSocketKind',
        'detectWebTransportSupport',
        'diffObservation',
        'READY_STATE',
        'WorkerAgnostic',
        'b2o',
        'canUseNativeClone',
        'collectTransferables',
        'createBroadcastBus',
        'createOperationContext',
        'getResourcePressure',
        'createFrameDecoder',
        'createObservation',
        'createWebTransportAdapter',
        'createSseAdapter',
        'decodeInbound',
        'decodeMessage',
        'detectEnv',
        'encodeMessage',
        'encodeNative',
        'encodeNativeEnvelope',
        'announceCapabilities',
        'formatErrorObj',
        'formatPrometheus',
        'frameEncodedJson',
        'frameTransferList',
        'isCapabilityAnnouncement',
        'isNativeEnvelope',
        'isRawPayload',
        'MESSAGE_CODECS',
        'NATIVE_ENVELOPE_KEY',
        'NATIVE_PROTOCOL_VERSION',
        'measureAsync',
        'measureSync',
        'monoMs',
        'normalizeError',
        'nowMs',
        'o2b',
        'o2u8',
        'preloadNode',
        'selectCodec',
        'simpleArgsKey',
        'u82o',
      ].sort()
    );
  });

  it('pins the internal constants module, which ships in types but not the API', () => {
    // `constants.js` is *not* exported from the package root - it is internal,
    // and its names leak into the published `.d.ts` JSDoc. So it has no
    // consumer-visible contract to snapshot, but it does have a naming
    // discipline, and the 2.0 work violated it once.
    expect(Object.keys(constants).sort()).toEqual([
      'CHUNKS_PER_WORKER_TARGET',
      'CHUNK_WINDOW_MULTIPLIER',
      'DECORRELATED_JITTER_FACTOR',
      'DEFAULT_AUTOSCALE_AIMD_BETA',
      'DEFAULT_AUTOSCALE_BACKOFF_MAX_MULTIPLIER',
      'DEFAULT_AUTOSCALE_COOLDOWN_MS',
      'DEFAULT_AUTOSCALE_INTERVAL_MS',
      'DEFAULT_AUTOSCALE_LONG_WINDOW_ALPHA',
      'DEFAULT_AUTOSCALE_MIN_INTERVAL_MS',
      'DEFAULT_BACKPRESSURE_QUEUE_CAPACITY',
      'DEFAULT_BACKPRESSURE_REFILL_INTERVAL_MS',
      'DEFAULT_BATCH_MAX_SIZE',
      'DEFAULT_CACHE_DEFAULT_TTL_MS',
      'DEFAULT_CACHE_MAX_POOL_SIZE',
      'DEFAULT_CACHE_MAX_WEIGHT_BYTES',
      'DEFAULT_CIRCUIT_MAX_OPEN_FACTOR',
      'DEFAULT_CIRCUIT_MIN_JITTER_RATIO',
      'DEFAULT_HARDWARE_CONCURRENCY',
      'DEFAULT_HISTOGRAM_BUCKET_COUNT',
      'DEFAULT_HISTOGRAM_MAX_VALUE',
      'DEFAULT_HISTOGRAM_RELATIVE_ACCURACY',
      'DEFAULT_IDEMPOTENCY_SWEEP_BATCH',
      'DEFAULT_MAX_CLEANUP_PER_TICK',
      'DEFAULT_MAX_DRAIN_WAITERS',
      'DEFAULT_POOL_IDLE_TIMEOUT_MS',
      'DEFAULT_POOL_SIZE',
      'DEFAULT_QUEUE_CAPACITY',
      'DEFAULT_REAPER_MIN_INTERVAL_MS',
      'DEFAULT_REFILL_INTERVAL_MS',
      'DEFAULT_RETRY_BASE_DELAY_MS',
      'DEFAULT_RETRY_BUDGET_CAPACITY',
      'DEFAULT_RETRY_BUDGET_RATIO',
      'DEFAULT_RETRY_MAX_DELAY_MS',
      'DEFAULT_TIMEOUT_MS',
      'ENCODE_CACHE_LARGE_KEY_LENGTH',
      'MAX_DEEP_EQUAL_DEPTH',
      'MAX_DEEP_EQUAL_NODES',
      'MIN_HISTOGRAM_BUCKETS',
      'MS_PER_MIN',
      'MS_PER_SEC',
      'POWER_QUEUE_INITIAL_CAPACITY',
      'READY_STATE',
    ]);
  });

  it('every exported helper has a package.json subpath, not just the reverse', () => {
    // The gate above walks `package.json`, so it can only ever prove that a
    // declared subpath resolves. It says nothing about a helper that has *no*
    // subpath — which is how `PowerServo` shipped without one and every check in
    // this file stayed green. Tree shaking is the reason the subpaths exist, and
    // a consumer who cannot `import { PowerServo } from
    // 'performance-helpers/powerServo'` cannot tree-shake it, so the mapping has
    // to be checked in both directions.
    const p = pkg();
    // Named, not "anything without an export": both of these are internal and
    // neither is reachable from `src/index.js`, so a subpath would advertise a
    // module the public API does not include.
    const INTERNAL = new Set(['constants', 'jsdoc-types']);
    // `./now` and `./errors` mirror `src/utils/`. They are here because the
    // count below cannot be satisfied without them, so a future `src/utils/`
    // file forces a decision rather than quietly going missing.
    const UTIL_SUBPATHS = ['./now', './errors'];
    const helpers = readdirSync(new URL('../src/helpers/', import.meta.url))
      .filter((f) => f.endsWith('.js'))
      .map((f) => f.slice(0, -3))
      .filter((name) => !INTERNAL.has(name))
      .sort();

    const missing = helpers.filter((name) => !p.exports[`./${name}`]);
    expect(
      missing,
      'every helper needs its own subpath export so a consumer can tree-shake it.\n' +
        'Add to package.json "exports", alphabetically:\n' +
        missing
          .map(
            (n) =>
              `    "./${n}": {\n      "types": "./types/helpers/${n}.d.ts",\n` +
              `      "import": "./src/helpers/${n}.js",\n` +
              `      "default": "./src/helpers/${n}.js"\n    },`
          )
          .join('\n')
    ).toEqual([]);

    // And the counts have to move with it: a new helper is now two edits
    // (index.js and package.json) plus one number, rather than one edit that
    // nothing checked. The `src/utils/` subpaths are named rather than counted,
    // because they are the same tree-shaking contract for code that is not a
    // helper and would otherwise be a silent hole in this assertion.
    expect(Object.keys(p.exports).filter((k) => k !== './package.json').length).toBe(
      helpers.length + 1 + UTIL_SUBPATHS.length
    );
    for (const sub of UTIL_SUBPATHS) expect(p.exports[sub], sub).toBeTruthy();
  });

  it('every package.json subpath resolves to a real file with the types it promises', () => {
    const p = pkg();
    const subpaths = Object.keys(p.exports).filter((k) => k !== './package.json');
    // The pre-existing test covered 3 of these. If this count changes, a
    // subpath was added or removed and this file needs updating deliberately -
    // the count is here so that cannot happen by accident.
    // 43 after `./powerDatagramChannel` (WT-003). 42 after `./powerWebTransportAdapter`
    // (WT-002). 41 after `./powerMessagePort` (RT-019). 40 after `./powerCrossLock`
    // (GAP-008). 39 was after `./powerRTCChannel` (RT-017). 38 was after `./powerServo`,
    // which is the subpath the gate above could not ask for; 37 was after `./metrics`
    // (FEAT-007). 55 after `./powerApdex` (ADR-0014). The comment above is the
    // point: this number is here so a subpath cannot be added or removed by
    // accident, and the only legitimate way past it is to edit this line on
    // purpose.
    expect(subpaths.length).toBe(55);

    for (const sub of subpaths) {
      const entry = p.exports[sub];
      expect(entry, `subpath ${sub} has no entry`).toBeTruthy();
      for (const cond of ['types', 'import', 'default']) {
        expect(entry[cond], `subpath ${sub} is missing the "${cond}" condition`).toBeTruthy();
      }
      // `types` must exist, or a TypeScript consumer with `skipLibCheck: false`
      // breaks on a published package. The 2.0 Types section exists because
      // this was not true in 1.0.3.
      expect(
        readFileSync(new URL(`../${entry.types}`, import.meta.url), 'utf8').length,
        `subpath ${sub} points at a missing or empty types file`
      ).toBeGreaterThan(0);
    }

    expect(p.exports['.'].require).toBe('./dist/performance-helpers.cjs');
    for (const sub of subpaths.filter((name) => name !== '.')) {
      expect(p.exports[sub].require, `deep subpath ${sub} is ESM-only`).toBeUndefined();
    }
  });

  it('every non-root subpath points at a file that exists', () => {
    const p = pkg();
    for (const [sub, entry] of Object.entries(p.exports)) {
      if (sub === './package.json' || typeof entry === 'string') continue;
      for (const cond of ['import', 'default']) {
        if (!entry[cond]) continue;
        expect(
          readFileSync(new URL(`../${entry[cond]}`, import.meta.url), 'utf8'),
          `subpath ${sub} -> ${entry[cond]} does not exist`
        ).toBeTruthy();
      }
    }
  });
});

// A UMD/ESM export-parity assertion was tried here three times and removed each
// time, because `test/globalSetup.js` deletes and rebuilds `dist/` before any
// test runs, from the same `src/` this file imports - so within a run the two
// cannot diverge, and no such assertion can fail. Not because the comparison is
// broken, but because nothing is being compared that could differ. A guard that
// cannot fail reads as coverage while providing none.
//
// The real check lives outside vitest, where it has teeth:
//   node scripts/check-bundle-exports.mjs     (npm run check:bundle)
// It reads both artefacts from disk after a build, and is part of
// `npm run verify`. Demonstrated failing: adding an export to `src/index.js`
// without rebuilding reports the missing name and the stale bundle.

describe('MESSAGE_CODECS is a read-only registry, not a mutable Set', () => {
  // RT-025. The `@readonly` was a *type* claim with nothing behind it:
  // `Object.freeze` does not freeze a `Set`'s contents, so `add('bogus')`
  // succeeded and `PowerPool` — which validates `options.messageCodec` with
  // `MESSAGE_CODECS.has(...)` — then accepted 'bogus' and negotiated against a
  // protocol nobody implements, failing later and somewhere else.
  //
  // Asserted on the mutators throwing, with the read surface pinned alongside: a
  // fix that broke `.has()` would satisfy the throw alone.
  it('refuses to be widened, narrowed or emptied', () => {
    const codecs = index.MESSAGE_CODECS;
    for (const method of ['add', 'delete', 'clear']) {
      expect(() => codecs[method](method === 'add' ? 'bogus' : 'framed'), method).toThrow(
        /read-only/
      );
    }
    expect([...codecs], 'and the registry is unchanged').toEqual([
      'framed',
      'legacy',
      'negotiated',
    ]);
  });

  it('still reads as a Set, so `.has()` consumers are unaffected', () => {
    const codecs = index.MESSAGE_CODECS;
    expect(codecs).toBeInstanceOf(Set);
    expect(codecs.has('framed')).toBe(true);
    expect(codecs.has('bogus')).toBe(false);
    expect(codecs.size).toBe(3);
    expect(new Set(codecs).size).toBe(3);
  });
});
