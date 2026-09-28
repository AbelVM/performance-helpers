import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
        'PowerBackpressure',
        'PowerBatch',
        'PowerBulkhead',
        'PowerCache',
        'PowerChunker',
        'PowerCircuit',
        'PowerDeadline',
        'PowerDefer',
        'PowerEventBus',
        'PowerEventLoopMonitor',
        'PowerGCRA',
        'PowerHistogram',
        'PowerLatch',
        'PowerLogger',
        'PowerMemoizer',
        'PowerMessageCodec',
        'PowerObserver',
        'PowerPermitGate',
        'PowerPool',
        'PowerQueue',
        'PowerRateLimit',
        'PowerRealtimeHub',
        'PowerRetry',
        'PowerScheduler',
        'PowerSemaphore',
        'PowerSlidingWindow',
        'PowerSubscriberSet',
        'PowerTTLMap',
        'PowerThrottle',
        'PowerTimedCache',
        'PowerWebSocketClient',
        'READY_STATE',
        'WorkerAgnostic',
        'b2o',
        'canUseNativeClone',
        'decodeMessage',
        'detectEnv',
        'encodeMessage',
        'encodeNative',
        'formatErrorObj',
        'frameEncodedJson',
        'frameTransferList',
        'isRawPayload',
        'measureAsync',
        'measureSync',
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
      'DEFAULT_MAX_CLEANUP_PER_TICK',
      'DEFAULT_MAX_DRAIN_WAITERS',
      'DEFAULT_POOL_IDLE_TIMEOUT_MS',
      'DEFAULT_POOL_SIZE',
      'DEFAULT_QUEUE_CAPACITY',
      'DEFAULT_REAPER_MIN_INTERVAL_MS',
      'DEFAULT_REFILL_INTERVAL_MS',
      'DEFAULT_RETRY_BASE_DELAY_MS',
      'DEFAULT_RETRY_MAX_DELAY_MS',
      'DEFAULT_TIMEOUT_MS',
      'ENCODE_CACHE_LARGE_KEY_LENGTH',
      'MAX_DEEP_EQUAL_DEPTH',
      'MAX_DEEP_EQUAL_NODES',
      'MIN_HISTOGRAM_BUCKETS',
      'MS_PER_MIN',
      'MS_PER_SEC',
      'POWER_QUEUE_INITIAL_CAPACITY',
    ]);
  });

  it('every package.json subpath resolves to a real file with the types it promises', () => {
    const p = pkg();
    const subpaths = Object.keys(p.exports).filter((k) => k !== './package.json');
    // The pre-existing test covered 3 of these. If this count drops, a subpath
    // was removed and this file needs updating deliberately.
    expect(subpaths.length).toBe(34);

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
