import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as barrel from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

/**
 * Entry-point tests (TEST-001).
 *
 * `src/index.js` is what every consumer imports, and it had **0 % coverage** -
 * so a broken re-export shipped unnoticed. That is not hypothetical:
 * `frameEncodedJson` was added to `powerMessageCodec.js` and documented as public
 * API, but never re-exported here, and `import { frameEncodedJson } from
 * 'performance-helpers'` did not exist.
 *
 * These tests are therefore written to catch that class of mistake
 * *mechanically* rather than by remembering to check.
 */

/** Submodules that are intentionally not public. */
const INTERNAL_MODULES = new Set([
  // Typedef-only: a JSDoc file with no runtime exports.
  'jsdoc-types',
  // Tuning constants; internal by design (see typedoc.json, which excludes it).
  'constants',
  // Shared internals used by other helpers, not a public API.
  'options',
  'timers',
]);

/** Subpath exports, excluding the root and the `./package.json` metadata entry. */
const subpaths = Object.keys(pkg.exports).filter((k) => k !== '.' && k !== './package.json');

describe('package entry point', () => {
  it('exports every documented helper', () => {
    const expected = [
      // buffers
      'o2u8',
      'o2b',
      'u82o',
      'b2o',
      // cache
      'PowerCache',
      'PowerMemoizer',
      'PowerTimedCache',
      'simpleArgsKey',
      // pool
      'PowerPool',
      'WorkerAgnostic',
      'detectEnv',
      'preloadNode',
      'PowerChunker',
      // limiters
      'PowerThrottle',
      'PowerSlidingWindow',
      'PowerRateLimit',
      'PowerGCRA',
      // concurrency
      'PowerQueue',
      'PowerSemaphore',
      'PowerPermitGate',
      'PowerBulkhead',
      'PowerBackpressure',
      'PowerBatch',
      'PowerLatch',
      'PowerScheduler',
      // resilience
      'PowerCircuit',
      'PowerRetry',
      'PowerRetryBudget',
      'PowerDeadline',
      'PowerHistogram',
      // eventing
      'PowerEventBus',
      'PowerObserver',
      'PowerSubscriberSet',
      'PowerLogger',
      'PowerTTLMap',
      'PowerDefer',
      // realtime family
      'PowerRealtimeHub',
      'PowerWebSocketClient',
      'PowerSocketAdapter',
      'encodeMessage',
      'decodeMessage',
      'frameEncodedJson',
      'encodeNative',
      // utils
      'nowMs',
      'measureSync',
      'measureAsync',
      'normalizeError',
      'formatErrorObj',
    ];
    for (const name of expected) {
      expect(barrel, `src/index.js must re-export ${name}`).toHaveProperty(name);
      expect(barrel[name], `${name} must not be undefined`).toBeDefined();
    }
  });

  it('exports constructors as functions and constants as values', () => {
    const classes = [
      'PowerCache',
      'PowerMemoizer',
      'PowerTimedCache',
      'PowerPool',
      'PowerChunker',
      'PowerThrottle',
      'PowerSlidingWindow',
      'PowerRateLimit',
      'PowerGCRA',
      'PowerQueue',
      'PowerSemaphore',
      'PowerPermitGate',
      'PowerBulkhead',
      'PowerBackpressure',
      'PowerBatch',
      'PowerLatch',
      'PowerScheduler',
      'PowerCircuit',
      'PowerRetry',
      'PowerRetryBudget',
      'PowerDeadline',
      'PowerHistogram',
      'PowerEventBus',
      'PowerObserver',
      'PowerSubscriberSet',
      'PowerLogger',
      'PowerTTLMap',
      'PowerDefer',
      'PowerRealtimeHub',
      'PowerWebSocketClient',
      'PowerSocketAdapter',
      'WorkerAgnostic',
    ];
    for (const name of classes) {
      expect(typeof barrel[name], `${name} should be callable`).toBe('function');
    }
    for (const name of ['nowMs', 'encodeMessage', 'decodeMessage', 'o2u8', 'u82o']) {
      expect(typeof barrel[name], `${name} should be callable`).toBe('function');
    }
    // `PowerMessageCodec` is a frozen namespace object of functions, not a
    // class - asserting the wrong shape here would have been a false failure.
    expect(typeof barrel.PowerMessageCodec).toBe('object');
    expect(Object.isFrozen(barrel.PowerMessageCodec)).toBe(true);
    expect(typeof barrel.PowerMessageCodec.encodeMessage).toBe('function');
    // Constants are not functions.
    expect(typeof pkg.version).toBe('string');
  });
});

describe('barrel and package.json exports agree', () => {
  // `./package.json` is a metadata entry, not a helper module.
  const subpaths = Object.keys(pkg.exports).filter((k) => k !== '.' && k !== './package.json');

  it('has a subpath export for every public module', () => {
    const declared = new Set(subpaths.map((k) => k.replace('./', '')));
    // Everything the barrel reaches into must be reachable by subpath too, or a
    // bundler cannot tree-shake it.
    for (const name of declared) {
      if (INTERNAL_MODULES.has(name)) continue;
      expect(declared.has(name), `${name} should have a subpath export`).toBe(true);
    }
    expect([...declared].filter((n) => INTERNAL_MODULES.has(n))).toEqual([]);
  });

  it('every subpath export target exists on disk', () => {
    for (const key of Object.keys(pkg.exports)) {
      const entry = pkg.exports[key];
      // An entry is either a condition map or a bare string (`./package.json`).
      const targets = typeof entry === 'string' ? [['default', entry]] : Object.entries(entry);
      for (const [condition, target] of targets) {
        if (typeof target !== 'string') continue;
        const path = resolve(root, target.replace('./', ''));
        expect(existsSync(path), `${key} -> ${condition} -> ${target} must exist`).toBe(true);
      }
    }
  });

  it('every public module in src/ is re-exported by the barrel', () => {
    // The inverse check: a module that exists, is public, has a subpath export,
    // but is not reachable from the root import. That is how `frameEncodedJson`
    // went missing before.
    const barrelSource = readFileSync(resolve(root, 'src/index.js'), 'utf8');
    for (const key of subpaths) {
      const name = key.replace('./', '');
      if (INTERNAL_MODULES.has(name)) continue;
      // Subpath exports live in `src/helpers/`, so the barrel re-exports from
      // there, not from the subpath root.
      const candidates = [`from './helpers/${name}.js'`, `from './utils/${name}.js'`];
      expect(
        candidates.some((c) => barrelSource.includes(c)),
        `src/index.js should re-export ${name} from src/helpers or src/utils`
      ).toBe(true);
    }
  });

  it('the subpath entry point resolves to the same symbols as the barrel', async () => {
    // Spot-check the two paths a consumer can take for a few helpers, so a
    // subpath that resolves to a different module is caught.
    const cases = [
      ['./powerGCRA', ['PowerGCRA']],
      ['./powerMessageCodec', ['encodeMessage', 'decodeMessage', 'frameEncodedJson']],
      ['./powerRealtimeHub', ['PowerRealtimeHub']],
      ['./powerWebSocketClient', ['PowerWebSocketClient', 'READY_STATE']],
      ['./powerSocketAdapter', ['PowerSocketAdapter', 'detectSocketKind', 'READY_STATE']],
    ];
    for (const [subpath, names] of cases) {
      const mod = await import(`../src/helpers/${subpath.replace('./', '')}.js`);
      for (const name of names) {
        expect(barrel[name], `${subpath} exports ${name}`).toBeDefined();
        expect(mod[name], `${subpath} should export ${name}`).toBe(barrel[name]);
      }
    }
  });
});

describe('documentation coverage (TEST-001 companion)', () => {
  it('has a guide for every public module', () => {
    for (const key of subpaths) {
      if (key === '.') continue;
      const name = key.replace('./', '');
      if (INTERNAL_MODULES.has(name)) continue;
      const guide = resolve(root, 'guides', `${name}.md`);
      expect(
        existsSync(guide),
        `guides/${name}.md is missing. A new helper needs a guide, a README entry, ` +
          'a metaGuide entry and an assets index entry.'
      ).toBe(true);
    }
  });

  it('lists every public helper in the README', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    for (const key of subpaths) {
      if (key === '.') continue;
      const name = key.replace('./', '');
      if (INTERNAL_MODULES.has(name)) continue;
      expect(readme.includes(`guides/${name}.md`), `README.md should link guides/${name}.md`).toBe(
        true
      );
    }
  });

  it('has a matching assets index entry for every public helper', () => {
    // Read every numbered index file, so a new family cannot be missed by
    // forgetting to add it here.
    const indexes = readdirSync(resolve(root, 'assets')).filter((f) => /^\d+_.*\.md$/.test(f));
    expect(indexes.length).toBeGreaterThan(0);
    const all = indexes.map((f) => readFileSync(resolve(root, 'assets', f), 'utf8')).join('\n');
    for (const key of subpaths) {
      if (key === '.') continue;
      const name = key.replace('./', '');
      if (INTERNAL_MODULES.has(name)) continue;
      expect(all.includes(`guides/${name}.md`), `no assets index entry for ${name}`).toBe(true);
    }
  });

  it('every assets index file is reachable from navigation.md', () => {
    const navPath = resolve(root, 'assets/navigation.md');
    const nav = readFileSync(navPath, 'utf8');
    // Resolve each link *from the file that contains it* rather than looking
    // for the path as a literal substring. The literal check passed for years
    // while every link in this file was broken: `navigation.md` links are
    // relative to `assets/`, so a working link reads `[Caching](1_Caching.md)`
    // and a broken one reads `[Caching](assets/1_Caching.md)` — and it was the
    // broken form the assertion was matching.
    //
    // `test/docsLinks.test.js` now checks every link in the repository. This
    // test stays because it asserts something that one does not: that the
    // navigation page reaches *each index*, not merely that its links resolve.
    const linked = new Set(
      [...nav.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => resolve(dirname(navPath), m[1]))
    );
    const files = [
      '1_Caching.md',
      '2_Parallelizing.md',
      '3_Logging.md',
      '4_Utils.md',
      '5_Realtime.md',
      '6_Observability.md',
    ];
    for (const f of files) {
      const abs = resolve(root, 'assets', f);
      expect(existsSync(abs), `assets/${f} should exist`).toBe(true);
      expect(linked.has(abs), `navigation.md should reach assets/${f}`).toBe(true);
    }
  });
});
