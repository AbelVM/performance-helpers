import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as index from '../src/index.js';
import { PowerCache } from '../src/helpers/powerCache.js';
import { PowerTTLMap } from '../src/helpers/powerTTLMap.js';

const TYPES_DIR = path.resolve(process.cwd(), 'types', 'helpers');

/**
 * QUAL-011 (stats half): `stats()` and `getStats()` both work, everywhere.
 *
 * ## The defect this pins
 *
 * Nine helpers reported through `stats()` and one — `PowerPool` — through
 * `getStats()`. Nothing stated a rule for which, nothing pinned it, and it
 * reached the documentation as a false claim: `guides/metrics.md:5` asserted
 * that "every helper that reports anything does it through its own `stats()`",
 * and `llm.txt:32` repeated it as a one-line summary. Both were wrong about
 * `PowerPool`, and `guides/metrics.md:37` contradicted its own line 5 by
 * writing `metrics.register('pool', () => pool.getStats())`.
 *
 * The cost landed on callers, not on the library: a user who learned one helper
 * reached for the other name everywhere else and got `TypeError: x.getStats is
 * not a function` from whichever class they had not learned the exception to.
 *
 * `getStats()` is now declared explicitly on every reporting class and delegates
 * to `stats()`. `PowerPool` keeps `getStats` as its only spelling — renaming the
 * library's most widely used surface would be a breaking change, and the alias
 * makes both spellings valid anyway.
 *
 * It is written out per class rather than installed on the prototype by a
 * helper, and that is a measured reversal: the dynamic version worked at
 * runtime and was **absent from the generated `types/`**, because `tsc` cannot
 * see an `Object.defineProperty` applied at module scope. A TypeScript caller
 * would have got a type error on a method that exists. The test below pins the
 * descriptor being present on the prototype rather than the delegation, so a
 * return to that approach fails.
 *
 * Precedent for adding an alias deliberately and pinning the ones deliberately
 * *not* added: `lifecycleAliases.test.js` (QUAL-004).
 */

/** Classes reachable from the package root, with the arguments each needs. */
const REPORTERS = [
  ['PowerBulkhead', () => new index.PowerBulkhead({ maxConcurrency: 1 })],
  ['PowerCache', () => new index.PowerCache()],
  ['PowerMemoizer', () => new index.PowerMemoizer()],
  ['PowerTimedCache', () => new index.PowerTimedCache(1000)],
  ['PowerEventLoopMonitor', () => new index.PowerEventLoopMonitor({ intervalMs: 1000 })],
  ['PowerGCRA', () => new index.PowerGCRA({ rate: 10, per: 1000 })],
  ['PowerRetryBudget', () => new index.PowerRetryBudget()],
];

describe('stats()/getStats() parity', () => {
  it('inspected the classes it claims to', () => {
    // A list that silently stopped matching would make the assertions below
    // vacuous, so the count is asserted rather than assumed. `PowerPool`,
    // `PowerRealtimeHub`, `PowerSocketAdapter` and `PowerWebSocketClient` are
    // checked on their prototypes below instead: three of them need a live
    // socket or hub to instantiate, and a prototype check is the stronger
    // assertion for them anyway.
    expect(REPORTERS.length).toBe(7);
    for (const [name, make] of REPORTERS) {
      expect(typeof index[name], `${name} should be exported`).toBe('function');
      expect(make(), `${name} should be constructible`).toBeTruthy();
    }
  });

  it('every reporting class answers to both names, with the same value', () => {
    for (const [name, make] of REPORTERS) {
      const instance = make();
      expect(typeof instance.stats, `${name}.stats`).toBe('function');
      expect(typeof instance.getStats, `${name}.getStats`).toBe('function');
      // Deep equality rather than identity: `stats()` builds a fresh object on
      // most of these classes, so `===` would fail on a correct alias.
      expect(instance.getStats(), `${name} getStats() should match stats()`).toEqual(
        instance.stats()
      );
    }
  });

  it('PowerPool still answers to getStats, which is its only spelling', () => {
    // The one class the alias deliberately did *not* touch. Renaming it would
    // break its guide, its JSDoc and `test/invariants.test.js`; the alias means
    // a caller who learned `stats()` from any other helper is still right here.
    const pool = new index.PowerPool(
      function Silent() {
        this.onmessage = null;
        this.postMessage = () => {};
        this.terminate = () => {};
      },
      { size: 1, minSize: 1, maxSize: 1, lazy: false }
    );
    expect(typeof pool.getStats).toBe('function');
    // Not `toEqual(pool.getStats())`: `poolLiveDuration` is wall-clock, so two
    // calls legitimately differ. Assert the identifying fields instead, and
    // that the result is shaped like a stats object.
    const stats = pool.getStats();
    expect(stats.workerCount).toBe(1);
    expect(stats.activeTasks).toBe(0);
    expect(stats.isIdle).toBe(true);
    pool.terminate();
  });

  it('the socket and hub classes carry the alias on their prototype', () => {
    // Checked without instantiating: these need a live socket, a running hub or
    // an adapter, and a prototype check covers the actual risk — the alias
    // failing to install — without standing up three fixtures.
    for (const name of ['PowerRealtimeHub', 'PowerSocketAdapter', 'PowerWebSocketClient']) {
      expect(typeof index[name], `${name} exported`).toBe('function');
      expect(typeof index[name].prototype.getStats, `${name}.prototype.getStats`).toBe('function');
    }
  });

  it('the alias is not enumerable, so it cannot perturb a shape check', () => {
    // `Object.keys(instance)` is what a metrics collector or a `JSON.stringify`
    // walks. An enumerable prototype method would show up in a diff of a
    // reporting shape for no reason the caller can act on.
    const cache = new PowerCache();
    expect(Object.keys(cache)).not.toContain('getStats');
    expect(Object.keys(cache)).not.toContain('stats');
    expect(JSON.stringify(cache.getStats())).toBe(JSON.stringify(cache.stats()));
  });

  it('getStats is non-enumerable and own-property free on every prototype', () => {
    // Spelled out per class rather than installed with `Object.defineProperty`
    // on the prototype: a dynamic patch is invisible to `tsc`, so the generated
    // `types/` omitted it and every TypeScript caller got a type error on a
    // method that worked at runtime. This is the assertion that would catch a
    // regression to that approach, and it is also what keeps the published
    // types and the runtime honest about each other.
    for (const [name] of REPORTERS) {
      const proto = index[name].prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'getStats');
      expect(descriptor, `${name}.prototype own getStats`).toBeDefined();
      expect(descriptor.enumerable, `${name}.prototype getStats enumerable`).toBe(false);
    }
  });

  it('a TTL map is not given an alias it has nothing to report', () => {
    // The deliberately *withheld* case, pinned in the same spirit as
    // `lifecycleAliases.test.js`. `PowerTTLMap` has no `stats()`, so adding a
    // `getStats` that delegates to a missing method would hand a caller a
    // `TypeError` from a name this audit just taught them to expect.
    const map = new PowerTTLMap();
    expect(map.stats).toBeUndefined();
    expect(map.getStats).toBeUndefined();
  });
});
/**
 * The generated declarations, checked separately because the failure they guard
 * is invisible from the source.
 *
 * The first implementation installed `getStats` with a dynamic
 * `Object.defineProperty` on the prototype. It worked at runtime, every test
 * above passed, and the method was **absent from `types/`** — `tsc` cannot see a
 * prototype patch applied at module scope. A TypeScript caller would have got
 * "Property 'getStats' does not exist" on a method that ran fine.
 *
 * So this reads the shipped `.d.ts` files and asserts each `getStats` is
 * declared with the *same* type as the `stats()` it delegates to. That is the
 * specific drift: an alias whose published type is narrower, wider or unrelated
 * to the method behind it is worse than no alias, because it type-checks and
 * then lies.
 */
describe('getStats is declared in the published types', () => {
  const read = (f) => readFileSync(path.join(TYPES_DIR, f), 'utf8');

  /**
   * Extract the type expression of `name():` from a declaration file.
   * @param {string} src
   * @param {string} name
   * @returns {string|null}
   */
  const signature = (src, name) => {
    const m = new RegExp(`^\\s+${name}\\(\\):`, 'm').exec(src);
    if (!m) return null;
    let depth = 0;
    const i = m.index + m[0].length;
    for (let j = i; j < src.length; j += 1) {
      const c = src[j];
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0)
          return src
            .slice(i, j + 1)
            .replace(/\s+/g, ' ')
            .trim();
      } else if (c === ';' && depth === 0) return src.slice(i, j).replace(/\s+/g, ' ').trim();
    }
    return null;
  };

  /** file -> class name, for the files that declare both spellings. */
  const FILES = [
    ['powerGCRA.d.ts', 'PowerGCRA'],
    ['powerCache.d.ts', 'PowerCache'],
    ['powerBulkhead.d.ts', 'PowerBulkhead'],
    ['powerEventLoopMonitor.d.ts', 'PowerEventLoopMonitor'],
    ['powerRealtimeHub.d.ts', 'PowerRealtimeHub'],
    ['powerRetry.d.ts', 'PowerRetryBudget'],
    ['powerSocketAdapter.d.ts', 'PowerSocketAdapter'],
    ['powerWebSocketClient.d.ts', 'PowerWebSocketClient'],
  ];

  it('read the generated types it claims to', () => {
    for (const [file, cls] of FILES) {
      expect(read(file), `${file} should exist`).toMatch(new RegExp(`class ${cls}\\b`));
    }
  });

  it('declares getStats on every helper that has stats, in both directions', () => {
    // Presence and *symmetry*, not string equality. The two declarations
    // legitimately differ in spelling: where `stats()` says
    // `PowerRetryBudgetStats`, the inferred `getStats()` says
    // `import("./jsdoc-types.js").PowerRetryBudgetStats`. Comparing the strings
    // reported that as a mismatch and pushed a hand-written `@returns` back onto
    // nine classes — which is the duplication this test was originally written to
    // justify, and which went stale the moment `PowerCache.stats()` changed.
    //
    // Semantic equivalence is asserted properly in `test/types.test-d.ts`, which
    // compiles bidirectional assignments against the declarations and so proves
    // what a consumer actually sees. This test keeps the cheap structural check:
    // the method exists, and it is not an `any` or an empty object.
    for (const [file, cls] of FILES) {
      const src = read(file);
      const getStats = signature(src, 'getStats');
      expect(getStats, `${cls}: getStats must be declared in ${file}`).not.toBeNull();
      // `any` is the one failure that matters: an alias typed `any` would accept
      // anything and catch nothing. A plain `object` is *faithful* rather than
      // wrong — `PowerSocketAdapter.stats()` itself declares `{object}`, and its
      // alias must agree with that rather than invent a shape for it.
      expect(getStats, `${cls}: getStats() must not be typed any`).not.toBe('any');
      expect(getStats, `${cls}: getStats() must not be an empty object type`).not.toBe('{}');
    }
  });

  it('declares all three cache-shaped aliases, not just the first', () => {
    // The scripted insertion that produced the broken `@returns` also only
    // replaced the *first* matching block in a file, so `PowerMemoizer` and
    // `PowerTimedCache` kept a malformed annotation while the file looked
    // correct. Counting catches that; `powerCache.d.ts` declares all three.
    const src = read('powerCache.d.ts');
    expect((src.match(/^\s+getStats\(\):/gm) || []).length).toBe(3);
  });

  it('leaves PowerPool with getStats and no stats, as it was', () => {
    // The one class the alias deliberately did not touch. Asserted so a future
    // "consistency" pass does not rename the library's largest surface.
    const src = read('powerPool.d.ts');
    expect(signature(src, 'getStats')).not.toBeNull();
    expect(signature(src, 'stats')).toBeNull();
  });
});
