import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import * as api from '../src/index.js';

/**
 * Every **public** helper class must reject unknown options.
 *
 * **Why this is a meta-test rather than one more case in a class's own file.** The
 * gap was never one class: 21 of 23 classes taking options already validated, so
 * `PowerCache` looked like an oversight rather than a pattern, and it survived
 * review after review. A per-class test cannot catch "the *next* class somebody
 * adds without one", and that is the failure that actually recurred — the
 * whitelist that looked like it covered `PowerCache` belonged to `PowerMemoizer`.
 *
 * Scoped to the **public** surface on purpose. `SmallLfuSketch` does not validate
 * and is not exported from `src/index.js`; it is constructed only by `powerCache.js`,
 * so a typo there is a library bug that the cache's own tests would catch, not a
 * caller's typo. Requiring validation there would be a rule with no failure behind
 * it, and `AGENTS.md` is explicit that a guard nobody has seen fail is a
 * hypothesis.
 */

/** Module files under src/ that could declare an exported class. */
function sourceFiles() {
  return [
    ...readdirSync('src/helpers').map((f) => `src/helpers/${f}`),
    ...readdirSync('src/utils').map((f) => `src/utils/${f}`),
  ].filter((f) => f.endsWith('.js'));
}

/** Exported class names per source file. */
const exportedClasses = new Map();
for (const file of sourceFiles()) {
  const src = readFileSync(file, 'utf8');
  // Two declaration forms: `export class X` / `export default class X`, **and**
  // `class X` … `export default X` at the bottom of the file. `WorkerAgnostic` is
  // the second, and an earlier version of this regex matched only the first — the
  // next assertion caught the omission, which is exactly what it is for.
  const names = [
    ...[...src.matchAll(/^export (?:default )?class (\w+)/gm)].map((m) => m[1]),
    ...[...src.matchAll(/^export default (\w+);?$/gm)].map((m) => m[1]),
  ];
  if (names.length) exportedClasses.set(file, { names, src });
}

/** True when the class takes an options object at all. */
function takesOptions(src) {
  return (
    /constructor\s*\(\s*\{/.test(src) ||
    /constructor\s*\(\s*\w+\s*=\s*\{\s*\}/.test(src) ||
    /\bopts?\.[a-zA-Z]/.test(src)
  );
}

// **Filter on the key, not the value.** An earlier draft wrote
// `/^[A-Z]/.test(v)` — testing the *function's* string form, which begins
// `class` or `function` and never `Power…` — so this resolved **zero** entries
// and the whole file passed vacuously with "0 gaps". The first assertion below is
// what caught it, which is why it is there and not decoration.
const publicClassEntries = Object.entries(api).filter(
  ([name, value]) => typeof value === 'function' && /^[A-Z]/.test(name)
);

describe('every public helper class validates its options', () => {
  it('finds the public classes at all, so the sweep cannot pass vacuously', () => {
    // **The guard on the guard.** A sweep that resolved zero classes would report
    // "0 gaps" and look like a clean bill of health. This asserts the population
    // exists and is plausibly sized.
    expect(publicClassEntries.length, 'public classes found').toBeGreaterThan(20);
    expect(exportedClasses.size, 'source files with classes').toBeGreaterThan(15);
  });

  it('every public class is covered by the source sweep, not missed by it', () => {
    // A public class whose file the sweep could not parse would silently escape
    // the check below. This closes that hole: each public class must be found in
    // some source file.
    const inSource = new Set([...exportedClasses.values()].flatMap((v) => v.names));
    const missing = publicClassEntries.map(([name]) => name).filter((name) => !inSource.has(name));
    expect(missing, 'public classes the source sweep cannot see').toEqual([]);
  });

  it('no public class destructures options without assertKnownOptions', () => {
    // The actual check. `MetricsCollector` and `PowerCache` were the two that
    // failed it: `{ registr: fn }` and `{ maxEntriess: 5 }` were both accepted
    // silently, leaving metrics off and the cache unbounded respectively.
    const gaps = [];
    for (const [file, { names, src }] of exportedClasses) {
      if (!takesOptions(src)) continue;
      if (/assertKnownOptions/.test(src)) continue;
      for (const name of names) {
        if (name in api) gaps.push(`${name} (${file})`);
      }
    }
    expect(
      gaps,
      'public classes that take options but never validate them. A misspelt option is ' +
        'then silently ignored, which is how an unbounded cache and dead metrics both shipped.'
    ).toEqual([]);
  });

  it('a public class does reject a nonsense option, checked on the real API', () => {
    // **On the real export surface, not a fixture.** The sweep above is static —
    // it reads source text — so this is the one assertion that proves the exports
    // actually behave. Without it the whole file could pass while the runtime
    // check was wired to something unreachable.
    expect(() => new api.PowerCache({ thisOptionDoesNotExist: 1 })).toThrow(
      /thisOptionDoesNotExist/
    );
    expect(() => new api.MetricsCollector({ thisOptionDoesNotExist: 1 })).toThrow(
      /thisOptionDoesNotExist/
    );
  });

  it('accepts every option it claims to, so the whitelist is not over-narrow', () => {
    // **The other direction, and the meta-test did not cover it.** A mutation that
    // changed `MetricsCollector`'s accepted list from `['prefix']` to `['prefx']`
    // passed this file 6/6 — every earlier assertion proves a class *rejects*
    // nonsense, and none of them notice a class that rejects something **valid**.
    // A misspelt entry in a hand-written whitelist is exactly as likely as a
    // missing one, and it is the more annoying failure: it turns a working config
    // into a TypeError at construction.
    //
    // **Scoped to the two classes whose whitelist this change touched.** Extending
    // it to all 22 would mean constructing every class with each of its documented
    // options, which is a fixture per class and a large test that would rot. The
    // gap is recorded rather than papered over.
    expect(() => new api.MetricsCollector({ prefix: 'app' })).not.toThrow();
    for (const opt of [
      { maxEntries: 5 },
      { maxWeight: 10 },
      { defaultTTL: 100 },
      { maxInflightRefreshes: 3 },
      { policy: 'lru' },
      // `allowStale` requires an explicit `staleTtl` — a separate, deliberate
      // validation. Passing it alone fails for that reason and not because the
      // whitelist is wrong, which is worth stating because it looks like the
      // latter from the assertion.
      { allowStale: true, staleTtl: 1000 },
      { admission: 'lru' },
      { windowSize: 10 },
      { rejectOversized: true },
      { maxPoolSize: 4 },
      { initialPoolSize: 2 },
      { maxCleanupPerTick: 5 },
      { defaultAsyncTimeout: 100 },
      { observability: true },
      { weightFn: () => 1 },
      { onEvict: () => {} },
      { onExpire: () => {} },
      { onError: () => {} },
      { fetchMethod: async () => 1 },
      { now: () => 0 },
    ]) {
      expect(
        () => new api.PowerCache(opt),
        `PowerCache must accept ${Object.keys(opt)[0]}`
      ).not.toThrow();
    }
  });
});
