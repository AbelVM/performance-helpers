/**
 * Every option a constructor destructures must be declared in its published
 * options type.
 *
 * This test exists because of a specific, repeated failure. Options are
 * documented in an `@typedef` *and* destructured in a constructor signature, and
 * the two are maintained by hand with nothing comparing them. Ten fields the
 * code actually reads were missing from the published `.d.ts` as a result, each
 * found only by running the type checker:
 *
 *   PowerPoolOptions       autoScale, messageCodec, awaitResponseTimeout,
 *                          slowTaskThreshold, maxListeners
 *   PowerCacheOptions      defaultAsyncTimeout, onError, policy
 *   _fetchValidNode opts   allowExpired
 *   WebSocketClientOptions onClose, onError, onPause, onResume, protocols,
 *                          dropOnBackpressure
 *
 * None of those broke a test. The option worked at runtime, so the behaviour
 * suite stayed green, and the consumer type test was the only thing that noticed
 * — and only because it happened to pass one of those options.
 *
 * The consumer test cannot catch this class of bug on its own: it only sees the
 * options someone thought to try. This test compares the two sides directly —
 * the names the constructor destructures in `src/`, against the names the
 * emitted declaration publishes — so a constructor that starts destructuring a
 * new option without documenting it fails here rather than in a consumer's
 * build.
 *
 * It reads the *emitted* `.d.ts` rather than the `@typedef` source, because the
 * emitted form is what a consumer actually sees and is what the emit could
 * plausibly mangle (QUAL-010 was exactly that: a JSDoc shorthand that parsed as
 * one property instead of five).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const TYPES_DIR = path.resolve(process.cwd(), 'types', 'helpers');
const SRC_DIR = path.resolve(process.cwd(), 'src', 'helpers');
const SHARED_PATH = path.join(TYPES_DIR, 'jsdoc-types.d.ts');

const read = (f) => readFileSync(f, 'utf8');

/**
 * The bound names of a destructuring pattern body.
 *
 * Split on top-level commas only, and drop comments. A plain `split(',')` is
 * wrong twice over on real constructor destructuring, and both halves produced
 * *false findings* rather than misses:
 *
 *   size = Math.min(hwConcurrency, DEFAULT_POOL_SIZE)   - the default contains
 *                                                           a comma, so it read
 *                                                           as two names
 *   // default timeout (ms) applied to awaitResponse…   - a comment line read
 *                                                           as a name
 *
 * and a spurious finding trains people to ignore the check, which is the exact
 * failure this test exists to prevent. Quotes are tracked so a `'//'` inside a
 * string default is not mistaken for a comment.
 *
 * @param {string} raw - A destructuring pattern body.
 * @returns {string[]} The bound names.
 */
function splitKeys(raw) {
  const entries = [];
  let depth = 0;
  let current = '';
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      current += ch;
      if (ch === '\\') {
        current += raw[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && raw[i + 1] === '*') {
      const end = raw.indexOf('*/', i + 2);
      i = end < 0 ? raw.length : end + 1;
      continue;
    }
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      entries.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) entries.push(current);

  // A rest element (`...rest`) is deliberately *not* reported. It is not an
  // option name at all: `PowerRetry` writes
  // `const { budget = null, ...rest } = options` and types the catch-all as
  // `PowerRetryOptions`, so the open-endedness is already stated in one place
  // and the rest binds nothing the declaration has to declare. Reporting it
  // would be a false positive about the one construct that means "there is no
  // fixed list".
  return entries
    .map((s) => s.trim().match(/^([A-Za-z_$][\w$]*)/))
    .filter(Boolean)
    .map((m) => m[1]);
}

/**
 * The keys of `const { … } = <param>` inside the constructor starting at
 * `ctorLine`, stopping at the constructor's own closing brace.
 *
 * Scoped to the constructor body so a same-named option object elsewhere in the
 * class cannot be attributed to this constructor.
 *
 * Searches the whole body rather than one line at a time, because the
 * destructuring is routinely spread over several lines (`PowerBackpressure`
 * alone is eight). The earlier line-at-a-time scan simply did not see those
 * constructors, which is most of the reason coverage used to read as "2".
 *
 * Takes a line *index* rather than the line's text. `powerRetry.js` has two
 * constructors whose signature is character-for-character identical
 * (`constructor(options = {}) {`, in `PowerRetryBudget` and in `PowerRetry`),
 * and locating the body by searching for that text found the first one both
 * times - so `PowerRetry` was cross-checked against the budget's `ratio` and
 * `capacity`, which its own options type does not declare.
 *
 * @param {string[]} lines - The module source, split into lines.
 * @param {number} ctorIndex - Index of the `constructor(` line.
 * @param {string} param - The constructor's options parameter name.
 * @returns {string} The destructuring pattern body, or ''.
 */
function readBodyDestructuring(lines, ctorIndex, param) {
  // Bounded by the constructor's own closing brace, and deliberately *not* by a
  // fixed line count. A constructor that validates its options lists every name
  // in an `assertKnownOptions` array *before* it destructures, so where the
  // destructuring statement lands depends on how many option names the class
  // accepts. `PowerCache`'s terminator sat at line 257 against an 80-line window
  // ending at 252; adding `seed` moved it to 259, one line further out, and this
  // function began returning '' for a constructor it had been reading correctly
  // the week before.
  //
  // That is the worst failure mode a guard has: it does not report a missing
  // declaration, it stops looking. `PowerCache` then vanished from
  // `surfacesChecked` and the two tripwires at the bottom of this file fired at
  // 19 and at `undefined` — which is the only reason this was caught rather than
  // absorbed as a quieter count. A loosened tripwire would have hidden it, so
  // the cap was removed instead of raised.
  const rest = lines.slice(ctorIndex).join('\n');
  // A class member's closing brace is the first `\n  }`; anything nested deeper
  // is indented further, so this lands on the constructor's own end and not
  // before it. Deliberately *not* `indexOf('  }')`, which matches the two inner
  // spaces of a 4-space-indented `    } = options` and truncates mid-pattern.
  const stop = rest.search(/\n {2}\}/);
  const scope = stop < 0 ? rest : rest.slice(0, stop);
  const m = scope.match(new RegExp(`const\\s*\\{([\\s\\S]*?)\\}\\s*=\\s*${param}\\b`));
  return m ? m[1] : '';
}

/**
 * The parameter names of a one-line constructor signature, in order.
 *
 * Split on top-level commas only: `PowerTimedCache(ttl, { maxEntries, interval })`
 * has a comma inside its second parameter's braces, and a naive split reports
 * three parameters for two.
 *
 * @param {string} ctorLine - The `constructor(…)` line.
 * @returns {string[]} Leading identifiers of the non-destructured parameters.
 */
function constructorParamNames(ctorLine) {
  const open = ctorLine.indexOf('(');
  let depth = 0;
  let end = -1;
  for (let i = open; i < ctorLine.length; i += 1) {
    const ch = ctorLine[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const parts = [];
  let inner = 0;
  let current = '';
  for (const ch of ctorLine.slice(open + 1, end)) {
    if ('([{'.includes(ch)) inner += 1;
    else if (')]}'.includes(ch)) inner -= 1;
    if (ch === ',' && inner === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts
    .map((p) => p.trim().match(/^([A-Za-z_$][\w$]*)/))
    .filter(Boolean)
    .map((m) => m[1]);
}

const sharedSource = read(SHARED_PATH);

/**
 * Remove `//` and block comments, leaving string literals intact.
 *
 * The declaration side is scanned for structure with a brace/colon regex, and
 * the doc comments above those declarations are full of braces and colons -
 * ``@typedef`` bodies routinely show example snippets. Reading a comment's
 * `{` as a type body's opening brace can push every subsequent key out of the
 * level the scan counts, and that failure is silent: keys go *missing*, so a
 * real drift stops being reported.
 *
 * @param {string} text - Source text.
 * @returns {string} The same text with comments removed.
 */
function stripComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * The top-level property names of an emitted `export type Name = { … }`.
 *
 * @param {string} input - A `.d.ts` file's contents.
 * @param {string} typedefName - The exported type to read.
 * @param {number} [depth=0] - Alias-hop guard.
 * @returns {Set<string>|null} Declared keys, or null when the type is absent or
 *   is not a plain object literal.
 */
function typedefKeys(input, typedefName, depth = 0) {
  if (depth > 3) return null;
  const source = stripComments(input);
  const decl = new RegExp(`export\\s+(?:declare\\s+)?type\\s+${typedefName}\\b[^=]*=`, 'm');
  const at = source.search(decl);
  if (at < 0) return null;

  let i = source.indexOf('=', at) + 1;
  while (i < source.length && /\s/.test(source[i])) i += 1;

  const alias = source.slice(i).match(/^import\("[^"]*jsdoc-types\.js"\)\.(\w+)/);
  if (alias) return typedefKeys(sharedSource, alias[1], depth + 1);
  if (source[i] !== '{') return null;

  let level = 0;
  let end = i;
  for (; end < source.length; end += 1) {
    if (source[end] === '{') level += 1;
    else if (source[end] === '}') {
      level -= 1;
      if (level === 0) break;
    }
  }

  const keys = new Set();
  let braceLevel = 0;
  for (const m of source.slice(i, end).matchAll(/[{}]|[A-Za-z_$][\w$]*\??\s*[:(]/g)) {
    if (m[0] === '{') braceLevel += 1;
    else if (m[0] === '}') braceLevel -= 1;
    else if (braceLevel === 1) keys.add(m[0].replace(/\??\s*[:(]$/, ''));
  }
  return keys.size ? keys : null;
}

/**
 * The names each exported class in a `.d.ts` destructures from its options.
 *
 * The emit keeps the destructuring pattern when the source had one, and reduces
 * it to `options?: Options` otherwise — so both are read, and the pattern is the
 * only place the source-side names appear in the declaration.
 *
 * @param {string} dts - The emitted declarations for one module.
 * @param {string} js - The corresponding source module.
 * @returns {{className: string, destructured: string[], declared: Set<string>|null}[]}
 */
function optionsSurfaces(dts, js) {
  // Source side. Two shapes are in use, and the emitted declaration only shows
  // the first:
  //   constructor({ a, b, c } = {})                   - signature destructuring
  //   constructor(options = {}) { const { a, b, c } = options; }
  // In the second shape the option names appear nowhere in the `.d.ts`, which is
  // half of why the drift went unnoticed. Attribution has to be exact: a class
  // can have several unrelated option objects (`PowerPool` destructures
  // `{ clone, zeroCopy }` from a *postMessage* options argument, and
  // `PowerRealtimeHub` destructures `SubscriberOptions`), so a bare
  // "const { … } = options" scan reports fields against the wrong type.
  //
  // The source-side names are therefore recorded *per parameter*, because that
  // is the thing the declaration gives a type to. `PowerMemoizer(fn, options)`
  // destructures `options` and not `fn`; keying only by class would have had to
  // guess.
  const srcDestructured = new Map();
  const srcByParam = new Map();
  const jsLines = js.split('\n');
  let currentClass = null;
  for (let at = 0; at < jsLines.length; at += 1) {
    const line = jsLines[at];
    const cls = line.match(/^export class (\w+)/);
    if (cls) {
      currentClass = cls[1];
      continue;
    }
    if (!currentClass) continue;
    const ctor = line.match(/^\s*constructor\(\s*(?:\{([\s\S]*?)\}|([A-Za-z_$][\w$]*))/);
    if (!ctor) continue;

    if (ctor[1]) {
      // Signature destructuring, and - because the emitter gives this
      // parameter the name `options` in the declaration - the options surface.
      const keys = splitKeys(ctor[1]);
      if (keys.length) {
        srcDestructured.set(currentClass, keys);
        if (!srcByParam.has(currentClass)) srcByParam.set(currentClass, new Map());
        srcByParam.get(currentClass).set('options', keys);
      }
    }
    for (const name of constructorParamNames(line)) {
      const keys = splitKeys(readBodyDestructuring(jsLines, at, name));
      if (!keys.length) continue;
      if (!srcByParam.has(currentClass)) srcByParam.set(currentClass, new Map());
      srcByParam.get(currentClass).set(name, keys);
    }
  }

  const out = [];
  let className = null;
  for (const line of dts.split('\n')) {
    const cls = line.match(/^export (?:declare )?class (\w+)/);
    if (cls) className = cls[1];

    // A destructured parameter may be preceded by positional ones
    // (`PowerTimedCache(ttl, { … })`), so the pattern is not anchored to the
    // open paren.
    const pattern = line.match(/constructor\([^)]*?\{([^}]*)\}\?:\s*([^,]+)/);
    if (pattern && className) {
      out.push({
        className,
        destructured: splitKeys(pattern[1]),
        declared: resolveType(pattern[2].trim(), dts),
      });
      continue;
    }

    // `constructor(options?: Options)` — the names only exist in the source.
    const named = line.match(/constructor\([^)]*?\boptions\??:\s*([^,)]+)/);
    if (named && className && srcByParam.get(className)?.has('options')) {
      out.push({
        className,
        destructured: srcByParam.get(className).get('options'),
        declared: resolveType(named[1].trim(), dts),
      });
    }
  }
  return out;
}

/** @returns {Set<string>|null} */
function resolveType(typeText, dts) {
  const imported = typeText.match(/import\("[^"]*jsdoc-types\.js"\)\.(\w+)/);
  if (imported) return typedefKeys(sharedSource, imported[1]);
  if (typeText.startsWith('{')) {
    const keys = new Set();
    for (const m of typeText.matchAll(/([A-Za-z_$][\w$]*)\??\s*:/g)) keys.add(m[1]);
    return keys.size ? keys : null;
  }
  const bare = typeText.match(/^(\w+)/);
  if (bare) return typedefKeys(dts, bare[1]) || typedefKeys(sharedSource, bare[1]);
  return null;
}

const typeFiles = readdirSync(TYPES_DIR).filter(
  (f) => f.endsWith('.d.ts') && f !== 'jsdoc-types.d.ts'
);

const findings = [];
let surfacesChecked = 0;

for (const file of typeFiles) {
  const jsPath = path.join(SRC_DIR, file.replace(/\.d\.ts$/, '.js'));
  let js;
  try {
    js = read(jsPath);
  } catch {
    continue; // no 1:1 source module (e.g. a pure type module)
  }
  for (const s of optionsSurfaces(read(path.join(TYPES_DIR, file)), js)) {
    if (!s.declared || !s.destructured.length) continue;
    surfacesChecked += 1;
    for (const key of s.destructured) {
      if (!s.declared.has(key)) {
        findings.push(
          `${s.className} (${file}): destructures \`${key}\` but the published options type does not declare it`
        );
      }
    }
  }
}

describe('published options types declare everything the constructors destructure', () => {
  it('the extraction works, so a silent no-pass is impossible', () => {
    const cache = optionsSurfaces(
      read(path.join(TYPES_DIR, 'powerCache.d.ts')),
      read(path.join(SRC_DIR, 'powerCache.js'))
    );
    const powerCache = cache.find((c) => c.className === 'PowerCache');
    expect(powerCache).toBeDefined();
    expect(powerCache.destructured).toContain('maxEntries');
    expect(powerCache.destructured).toContain('policy');
    expect(powerCache.declared?.has('policy')).toBe(true);
  });

  it('inspected the constructors it claims to', () => {
    // A regex change that stopped matching would make the assertion below
    // vacuously true, so the count is asserted rather than assumed.
    //
    // This was 2 when QUAL-001 finished moving the constructors onto named
    // option types, and the reason was not that only two constructors had a
    // nameable options type. The source-side scan only read *one line* of a
    // constructor body at a time, so any `const { … } = options` spread over
    // several lines — `PowerBackpressure`, `PowerHistogram`,
    // `PowerEventLoopMonitor`, and every other multi-line one — was invisible;
    // and the declaration-side pattern match was anchored to the open paren, so
    // a destructured *second* parameter (`PowerTimedCache(ttl, { … })`) was
    // invisible too. 20 is the real number now, and the assertion is set at 20
    // so a future regex that quietly stops matching fails loudly.
    //
    // Still out of scope, honestly: helpers whose constructors take positional
    // arguments only (`PowerQueue(0)`, `PowerTimedCache(ttl)`'s first
    // parameter, `PowerSemaphore(limit)`) and the per-*method* option objects. A
    // constructor that does not destructure its options — `PowerDeadline` and
    // `PowerTTLMap` both just keep the object — has no names to cross-check and
    // is skipped by design.
    expect(surfacesChecked).toBeGreaterThanOrEqual(20);
  });

  it('no constructor destructures an option its published type does not declare', () => {
    // Verified to have teeth, twice, at the two shapes of constructor this test
    // has to read. Deleting a key from the typedef, regenerating, and running
    // produces:
    //
    //   removing `queueCapacity` from `PowerPermitGateOptions` (single-line
    //   destructuring) ->
    //     PowerPermitGate (powerPermitGate.d.ts): destructures `queueCapacity`
    //     but the published options type does not declare it
    //
    //   removing `refillInterval` from `PowerBackpressureOptions` (an eight-line
    //   destructuring, invisible to the previous line-at-a-time scan) ->
    //     PowerBackpressure (powerBackpressure.d.ts): destructures
    //     `refillInterval` but the published options type does not declare it
    //
    // The second is the one that matters: extending a check from 2 surfaces to
    // 20 is exactly the kind of change that can quietly stop finding anything
    // and still pass. It then went on to catch a mistake of my own - a revert
    // of the first teeth edit that dropped `queueCapacity` instead of restoring
    // it - which is the second proof that it reads the declarations.
    expect(findings).toEqual([]);
  });
});
