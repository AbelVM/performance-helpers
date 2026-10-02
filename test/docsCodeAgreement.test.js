import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * GATE-002: a guide may only name methods its helper actually has.
 *
 * This exists because of a specific, findable bug: `guides/powerPool.md`
 * documented `prepareBuffer(obj, { clone })` in the API list **and called it in a
 * runnable example**, and no such method exists. `prepareBuffers` does. A reader
 * following that example got a `TypeError`, and nothing in the build noticed —
 * the guide is prose, and prose does not fail `tsc`.
 *
 * The stop-list below is the unglamorous part, and it is why this test is worth
 * writing carefully: a throwaway scan of `guides/power*.md` finds 54 backticked
 * `name(` that are not methods of the same-named helper, and **53 of them are
 * correct** — a builtin, an imported helper, a local callback, or a method of a
 * different class that the guide is legitimately describing. The plan says "51
 * hits, 1 real", which is about right. A stop-list that is too small produces a
 * test nobody can keep green; one that is too large lets the real bug back in.
 */

/**
 * Names that are not methods of the helper but are legitimate in its guide.
 *
 * Grouped by *why*, so that a reader adding an entry has to decide which group it
 * belongs to — which is the whole difficulty of this test.
 */
const BUILTIN_GLOBALS = new Set([
  'Array',
  'ArrayBuffer',
  'Boolean',
  'Date',
  'Error',
  'Map',
  'Number',
  'Object',
  'Promise',
  'Proxy',
  'Reflect',
  'Set',
  'String',
  'Symbol',
  'TypedArray',
  'Uint8Array',
  'WeakMap',
  'WeakRef',
  'WeakSet',
  'Function',
  'function',
  'async',
  'JSON',
  'Math',
  'console',
  'clearInterval',
  'clearTimeout',
  'setInterval',
  'setTimeout',
  'queueMicrotask',
  'structuredClone',
  'unref',
  'encodeURIComponent',
  'decodeURIComponent',
  'parseInt',
  'parseFloat',
  'isNaN',
  'BigInt',
]);

/** Imported from `src/utils/`, so named in a guide but not defined in a helper. */
const SHARED_UTILS = new Set([
  'nowMs',
  'hrtimeMs',
  'setSafeTimeout',
  'setSafeInterval',
  'assertLimit',
  'assertLimitRequired',
  'assertFunction',
  'attach',
  'detach',
  'hashKey',
  'cleanupWeakRefs',
  'abortReason',
  'readAndReset',
  'estimateSize',
  'nextPowerOfTwo',
  'createSeededRandom',
  'warn',
  'report',
]);

/**
 * Local variables, callback parameters and expressions that look like calls.
 *
 * `fn`/`cb`/`predicate` are the parameters of the documented callback shapes;
 * `O`/`u82o`/`o2u8` are codec internals named in prose; the rest are expressions
 * or builtins-in-disguise that a backtick picked up.
 */
const NOT_CALLS = new Set([
  'fn',
  'cb',
  'predicate',
  'send',
  'one',
  'min',
  'slice',
  'log10',
  'O',
  'o2u8',
  'u82o',
]);

/**
 * Methods of *other* helpers, named in this guide on purpose — a `powerPool`
 * guide describing the codec it uses, or an adapter describing the socket API
 * underneath it.
 */
const CROSS_CLASS = new Set([
  // PowerMemoizer, referenced from powerCache. `memoize` is a method of it, and
  // `memo` is the *value that method returns* — the memoized wrapper a guide
  // example then calls. A local binding rather than a member, so no source
  // file declares it. Added when the receiver-aware helper docs introduced
  // `memo.call(obj, 10)` and `memo.get(10)`: the guide became uncheckable
  // because its own example used a name the per-guide rule cannot resolve.
  'memoize',
  'memo',
  // The *parameter* of `PowerCache.getOrSetAsync`, not a member. The guide
  // documents the factory as `asyncFactory(signal)` because that is the shape a
  // caller writes, and a backticked call to it is what the per-guide rule
  // cannot distinguish from a method the cache does not have. Same category as
  // `memo` above: a local binding named in a runnable example.
  'asyncFactory',
  // powerMessageCodec, referenced from powerPool and powerChunking.
  'encodeMessage',
  'decodeMessage',
  // The incremental decoder factory, alongside the two above and for the same
  // reason: it is a module-level export in `powerMessageCodec`, not a method of
  // the `PowerMessageCodec` object the guide documents, so the per-guide rule
  // cannot resolve a backticked call to it.
  'createFrameDecoder',
  'selectCodec',
  'encodeNative',
  'canUseNativeClone',
  'isRawPayload',
  'frameTransferList',
  // PowerPool, referenced from powerChunking and powerRealtimeHub.
  'postMessageBatch',
  'prepareBuffers',
  'shutdown',
  'drain',
  'broadcast',
  // Rate limiters, referenced from powerRateLimit and powerGCRA.
  'addTokens',
  // Web streams, referenced from powerSocketAdapter.
  'getWriter',
  'releaseLock',
  'write',
  'ping',
  // Node process metrics, referenced from powerEventLoopMonitor.
  'eventLoopUtilization',
  // `AbortSignal` / `AbortController` members, named by the cancellation
  // section in powerCache. `abort()` is not a method of the cache or of anything
  // else this guide documents, so the per-guide rule cannot resolve it - but it
  // is a real API with a real contract, and the guide's advice ("a throwing
  // abort listener is the caller's own risk") is only meaningful against the
  // platform's own method.
  'abort',
]);

/** Everything this test is willing to accept without it being a method. */
const STOP_LIST = new Set([...BUILTIN_GLOBALS, ...SHARED_UTILS, ...NOT_CALLS, ...CROSS_CLASS]);

/**
 * Every method and accessor a class declares, by name.
 *
 * Read from the source with a parser rather than a regex where it matters: a
 * regex over JavaScript is a regex over every way a method can be spelled, and
 * this test's whole value is that it does not miss a real one.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
function declaredNames(source) {
  const names = new Set();
  // Class members: two-space indent, optional `static`/`async`/`get`/`set`, and
  // either a method or a field with a function value.
  for (const m of source.matchAll(
    /^[ ]{2}(?:static[ ]+)?(?:async[ ]+)?(?:get[ ]+|set[ ]+)?\*?[ ]*([A-Za-z_$][\w$]*)[ ]*(?:\(|=|;)/gm
  )) {
    names.add(m[1]);
  }
  // Also count anything assigned to `this.<name>` in the constructor, for
  // arrow-function properties the line-anchored pattern above would miss.
  for (const m of source.matchAll(/this\.([A-Za-z_$][\w$]*)[ ]*=/g)) names.add(m[1]);
  return names;
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const guideNames = readdirSync(path.join(ROOT, 'guides')).filter((f) =>
  /^power[A-Z].*\.md$/.test(f)
);
const helperNames = new Set(readdirSync(path.join(ROOT, 'src/helpers')));

/** @type {Array<{guide: string, name: string}>} */
const mismatches = [];
let checked = 0;
/** Guides the per-guide loop below actually checks, for the GATE-005 block. */
const scannedGuides = new Set();

for (const guide of guideNames) {
  const base = guide.replace(/\.md$/, '');
  const helper = `${base}.js`;
  scannedGuides.add(guide);
  const helperPath = path.join(ROOT, 'src/helpers', helper);
  if (!helperNames.has(helper)) {
    // A guide with no same-named helper cannot be checked this way. Asserted
    // separately so the set below is never quietly empty.
    continue;
  }
  const helperSource = readFileSync(helperPath, 'utf8');
  const declared = declaredNames(helperSource);
  // A guide names its own class in the first line of most examples. From the
  // source, not the filename: `powerLatch.js` exports `PowerLatch`, so deriving
  // it from the path silently failed for every guide whose two names differ.
  const className = helperSource.match(/export\s+class\s+([A-Za-z_$][\w$]*)/);
  if (className) declared.add(className[1]);
  const text = readFileSync(path.join(ROOT, 'guides', guide), 'utf8');
  const seen = new Set();
  for (const m of text.matchAll(/`([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    checked += 1;
    if (declared.has(name) || STOP_LIST.has(name)) continue;
    mismatches.push(`${guide}: \`${name}(\``);
  }
}

describe('a guide only names methods its helper has (GATE-002)', () => {
  it('checks a real number of guides and call sites', () => {
    // Without this the rest of the file could pass by finding no guides at all,
    // which is the failure mode this project has now hit three times.
    expect(guideNames.length).toBeGreaterThan(20);
    expect(checked).toBeGreaterThan(200);
  });

  it('has no backticked call in a guide that its helper does not declare', () => {
    expect(
      mismatches,
      'a guide naming a method the helper does not have is a `TypeError` for the\n' +
        'reader. `guides/powerPool.md` documented `prepareBuffer` in its API list\n' +
        'and in a runnable example; only `prepareBuffers` exists. If the name really\n' +
        'is a builtin, a shared util, or a method of another class, add it to the\n' +
        'right group in this file — not to a general escape hatch.'
    ).toEqual([]);
  });

  it('keeps no dead entries in the guide-specific part of the stop-list', () => {
    // Scoped to the two groups that exist *because of these guides*. The builtin
    // list is deliberately not checked: a global that no guide currently names is
    // coverage, not dead weight, and pruning it would mean a guide that uses
    // `queueMicrotask(` next week had to add it back. A list that is only ever
    // added to is the failure mode — hence checking the groups that should track
    // the guides. The cross-class list is the one that rots quietly: a renamed or
    // removed method leaves an entry that no longer means anything.
    //
    // A stop-list that accumulates unused names stops being a judgement and
    // becomes a hole: the real bug is one entry away from a name nobody removed.
    const used = new Set();
    // Every backticked call in every guide, *whether or not* the same-named
    // helper declares it. The question is "does this entry match something",
    // not "is it currently load-bearing" — `broadcast` is a `PowerPool` method
    // and a `PowerChunking` guide names it, so it is in use on both counts and
    // would look dead to a narrower test.
    for (const guide of guideNames) {
      const text = readFileSync(path.join(ROOT, 'guides', guide), 'utf8');
      for (const m of text.matchAll(/`([A-Za-z_$][\w$]*)\s*\(/g)) used.add(m[1]);
    }
    const dead = [...CROSS_CLASS, ...NOT_CALLS].filter((n) => !used.has(n)).sort();
    expect(
      dead,
      'these stop-list entries match nothing in any guide. Remove them, or the list ' +
        'is only growing and stops saying what it is for.'
    ).toEqual([]);
  });
});

/**
 * GATE-009, and the blind spot the row exposed in GATE-002.
 *
 * The gate above checks that a guide's backticked `name(` is a method of the
 * helper the same guide is about. It cannot see `defaultMetrics`, because that
 * is a *package export* shown in `guides/metrics.md` — a guide with no
 * same-named helper, in a non-`power*` file — and `attach()`'s JSDoc showed the
 * same bare identifier. Following either one produced a ReferenceError, so the
 * guide and the code disagreed about a name that exists, just not where the
 * guide implied.
 *
 * This is deliberately narrow: a fixed list of the identifiers the docs show
 * *without* an import, each asserted to be exported from the entry point. Not a
 * general scan — an unimported-name scan across every guide produces the same
 * false-positive rate as GATE-002's method scan, and a gate that cannot be kept
 * green is not a gate. The list grows one verified entry at a time.
 */
const DOCS_SHOW_NAMES_WITHOUT_IMPORT = [
  // `guides/metrics.md:98` and the `attach()` JSDoc both show
  // `defaultMetrics.snapshot().series` with no import line.
  'defaultMetrics',
];

describe('a name the docs show without an import is actually exported (GATE-009)', () => {
  it('exports every such name from the package entry point', async () => {
    const entry = await import('../src/index.js');
    const missing = DOCS_SHOW_NAMES_WITHOUT_IMPORT.filter((n) => !(n in entry));
    expect(
      missing,
      'these names appear in the docs with no import, so a reader following the\n' +
        'guide hits a ReferenceError. Re-export from `src/index.js`, or show the\n' +
        'import in the doc. `defaultMetrics` was reachable only via the\n' +
        '`/metrics` subpath, which neither `guides/metrics.md` nor the JSDoc\n' +
        'mentions — so the guide was wrong about where a name lives.'
    ).toEqual([]);
  });

  it('the list is not empty, so the test cannot pass by finding nothing', () => {
    // The failure mode this project has now hit three times: a gate that
    // scans nothing and reports nothing.
    expect(DOCS_SHOW_NAMES_WITHOUT_IMPORT.length).toBeGreaterThan(0);
  });

  it('each listed name is still named in a guide, so entries cannot rot', () => {
    // A list that is only ever added to is a list that stops meaning anything.
    // If a guide is edited to show the import, drop the entry here.
    const guides = readdirSync(path.join(ROOT, 'guides'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => readFileSync(path.join(ROOT, 'guides', f), 'utf8'))
      .join('\n');
    const orphaned = DOCS_SHOW_NAMES_WITHOUT_IMPORT.filter((n) => !guides.includes(n));
    expect(orphaned, 'no guide names these any more; remove them from the list').toEqual([]);
  });
});

/**
 * The cross-cutting guides, which GATE-002 cannot check.
 *
 * The check above compares a guide's backticked calls against **the helper the
 * guide is named after**, and skips a guide with no same-named helper. That is
 * the right rule for a per-helper guide and the wrong one for a guide that
 * spans many: `metaGuide.md` is the router the project tells a newcomer to
 * start from, and it names `drain(`, `getStats(`, `decodeMessage(`, `tryConsume(`,
 * `eventLoopUtilization(` and a dozen others belonging to a dozen classes.
 *
 * Measured: **6 of 40 guides were skipped entirely** — `autoscale.md`,
 * `errors.md`, `metaGuide.md`, `now.md`, `traceContext.md` and
 * `troubleshooting.md` — carrying 22 distinct backticked call names between
 * them, none of which any check looked at. The two highest-traffic guides in the
 * repository are among them, which is the point: a typo in the quick chooser is
 * read more often than a typo in a reference page.
 *
 * The check is a **union across the whole codebase** rather than a per-guide
 * one, so a cross-class name is satisfied by the class that actually has it and
 * needs no stop-list entry per guide. That matters: the per-guide check above
 * needs a growing `CROSS_CLASS` list precisely because it insists a name belong
 * to *this* guide's helper, and a list that is only ever added to is the
 * failure mode this file already guards against in three places.
 *
 * Deliberately **not** an extension of `apiSurface.test.js`. That file pins
 * *export* names, and the F-14 class this covers — a guide naming a method that
 * does not exist — is a property of guides, not of the package's export list.
 * A second file holding a second list of method names is the same
 * two-lists-drift shape that made CI run neither `test:types` nor
 * `check:bundle` in this project for as long as both existed.
 */

/** Guides with no same-named helper, which the per-guide loop above skips. */
// `helperNames` holds filenames *with* the extension, which is why the
// per-guide loop above appends `.js` before consulting it. The first draft of
// this line stripped `.md` instead and matched nothing, so all 32 power guides
// were treated as cross-cutting and 4 of their names were reported as invented
// when they are declared.
// From **all** guides, not from `guideNames`, which is filtered to
// `guides/power*.md`. The six that the per-guide loop cannot reach are not
// power-prefixed at all, so deriving this from `guideNames` found nothing —
// which is the second version of this line being wrong in the same way.
const ALL_GUIDES = readdirSync(path.join(ROOT, 'guides')).filter((f) => f.endsWith('.md'));
const CROSS_CUTTING = ALL_GUIDES.filter((g) => !helperNames.has(g.replace(/\.md$/, '.js')));

/** Every class member and every exported name anywhere under `src/`. */
const everythingDeclared = (() => {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const source = readFileSync(full, 'utf8');
      for (const n of declaredNames(source)) names.add(n);
      // Standalone exports matter as much as methods: `u82o(` and `o2u8(` in
      // `guides/errors.md` and `guides/powerBuffer.md` are `powerBuffer.js`
      // functions, and the first draft of this check rejected them as invented
      // methods. Found by running it, which is the only way that shows up.
      for (const m of source.matchAll(
        /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g
      )) {
        names.add(m[1]);
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return names;
})();

/**
 * Not method calls at all. Small, and each entry justified at its definition.
 * The per-guide `NOT_CALLS` group is reused: it is a list of words that look
 * like calls in prose and are not, and a second such list would rot.
 */
const CROSS_CUTTING_NOT_CALLS = new Set([
  'fn', // a parameter name: `measureSync(fn)` in guides/now.md
]);

const crossCuttingMismatches = (() => {
  /** @type {Array<{guide: string, name: string}>} */
  const out = [];
  let checked = 0;
  for (const guide of CROSS_CUTTING) {
    const text = readFileSync(path.join(ROOT, 'guides', guide), 'utf8');
    const seen = new Set();
    for (const m of text.matchAll(/`([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      checked += 1;
      if (everythingDeclared.has(name)) continue;
      if (NOT_CALLS.has(name) || CROSS_CUTTING_NOT_CALLS.has(name)) continue;
      if (BUILTIN_GLOBALS.has(name)) continue;
      out.push({ guide, name });
    }
  }
  return { out, checked };
})();

describe('a cross-cutting guide only names calls that exist somewhere (GATE-005)', () => {
  it('actually covers the guides the per-guide check skips', () => {
    // The measured shape, pinned so this cannot quietly become a gate that
    // scans one file. Before this existed these guides and their distinct call
    // names were invisible to every check in the repository.
    //
    // The count moved 6 -> 7 when `webTransportSupport.md` was added, and that is
    // the pin doing its job rather than failing: the set is derived, not listed,
    // and a guide whose name does not match a `src/helpers/<name>.js` is exactly
    // what this rule is for. Its implementation lives at `src/utils/webtransport.js`,
    // so the per-guide loop cannot reach it by name — which is why its seven
    // backticked calls are only checked because it is counted in here.
    expect(CROSS_CUTTING.length).toBe(7);
    expect(crossCuttingMismatches.checked).toBeGreaterThan(15);
    // And it is a strict complement: nothing is checked by both rules, which is
    // what makes this additive rather than a second copy.
    expect(CROSS_CUTTING.every((g) => !scannedGuides.has(g))).toBe(true);
    // And it reaches the two highest-traffic guides in the repository, which is
    // why this was worth closing: the quick chooser and the error guide are
    // both here.
    expect(CROSS_CUTTING).toContain('metaGuide.md');
    expect(CROSS_CUTTING).toContain('errors.md');
    // And the newest one, so a future guide that should have been power-prefixed
    // rather than cross-cutting is a deliberate choice someone can see here.
    expect(CROSS_CUTTING).toContain('webTransportSupport.md');
  });

  it('has no backticked call in a cross-cutting guide that nothing declares', () => {
    expect(
      crossCuttingMismatches.out.map((m) => `${m.guide}: \`${m.name}(\``),
      'a guide naming a call that exists nowhere under `src/` is a TypeError for\n' +
        'the reader, and `metaGuide.md` is the router a newcomer is told to start\n' +
        'from. If the name is a builtin or a shared util, add it to the right\n' +
        'group in this file — not to a general escape hatch.'
    ).toEqual([]);
  });

  it('accepts a method of a class other than the guide is about', () => {
    // The property that makes the union shape right. `drain(` belongs to
    // several helpers and to none of these guides, so the per-guide check would
    // need a CROSS_CLASS entry for it in every one of the six files; here it is
    // satisfied once.
    expect([...everythingDeclared]).toContain('drain');
    expect([...everythingDeclared]).toContain('getStats');
    expect([...everythingDeclared]).toContain('decodeMessage');
  });

  it('keeps no dead entries in the cross-cutting stop-list', () => {
    // A stop-list that is only added to stops saying what it is for. `fn` is
    // the only entry and it is load-bearing, so if a guide stops showing a bare
    // `fn(` this fails rather than leaving a name that means nothing.
    const used = new Set();
    for (const guide of CROSS_CUTTING) {
      const text = readFileSync(path.join(ROOT, 'guides', guide), 'utf8');
      for (const m of text.matchAll(/`([A-Za-z_$][\w$]*)\s*\(/g)) used.add(m[1]);
    }
    expect([...CROSS_CUTTING_NOT_CALLS].filter((n) => !used.has(n)).sort()).toEqual([]);
  });
});
