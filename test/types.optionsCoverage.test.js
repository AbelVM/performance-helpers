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
 * @param {string} raw - A destructuring pattern body.
 * @returns {string[]} The bound names.
 */
function splitKeys(raw) {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(/[:=]/)[0].trim())
    .filter(Boolean);
}

/**
 * The keys of `const { … } = <param>` inside the constructor starting at
 * `ctorLine`, stopping at the constructor's closing brace.
 *
 * Scoped to the constructor body so a same-named option object elsewhere in the
 * class cannot be attributed to this constructor.
 *
 * @param {string} source - The module source.
 * @param {string} ctorLine - The `constructor(` line, used to locate the body.
 * @param {string} param - The constructor's options parameter name.
 * @returns {string} The destructuring pattern body, or ''.
 */
function readBodyDestructuring(source, ctorLine, param) {
  const lines = source.split('\n');
  const startAt = source.slice(0, source.indexOf(ctorLine)).split('\n').length - 1;
  for (let i = startAt; i < Math.min(lines.length, startAt + 80); i += 1) {
    if (i > startAt && /^ {2}\}/.test(lines[i])) break;
    const m = lines[i].match(new RegExp(`const\\s*\\{([\\s\\S]*?)\\}\\s*=\\s*${param}\\b`));
    if (m) return m[1];
  }
  return '';
}

const sharedSource = read(SHARED_PATH);

/**
 * The top-level property names of an emitted `export type Name = { … }`.
 *
 * @param {string} source - A `.d.ts` file's contents.
 * @param {string} typedefName - The exported type to read.
 * @param {number} [depth=0] - Alias-hop guard.
 * @returns {Set<string>|null} Declared keys, or null when the type is absent or
 *   is not a plain object literal.
 */
function typedefKeys(source, typedefName, depth = 0) {
  if (depth > 3) return null;
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
  const srcDestructured = new Map();
  let currentClass = null;
  for (const line of js.split('\n')) {
    const cls = line.match(/^export class (\w+)/);
    if (cls) {
      currentClass = cls[1];
      continue;
    }
    if (!currentClass) continue;
    const ctor = line.match(/^\s*constructor\(\s*(?:\{([\s\S]*?)\}|(\w+))\s*=/);
    if (!ctor) continue;
    const keys = ctor[1] ? splitKeys(ctor[1]) : splitKeys(readBodyDestructuring(js, line, ctor[2]));
    if (keys.length) srcDestructured.set(currentClass, keys);
  }

  const out = [];
  let className = null;
  for (const line of dts.split('\n')) {
    const cls = line.match(/^export (?:declare )?class (\w+)/);
    if (cls) className = cls[1];

    const pattern = line.match(/constructor\(\s*\{([^}]*)\}\?:\s*([^,]+)/);
    if (pattern && className) {
      const keys = pattern[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.split(/[:=]/)[0].trim())
        .filter(Boolean);
      out.push({ className, destructured: keys, declared: resolveType(pattern[2].trim(), dts) });
      continue;
    }

    // `constructor(options?: Options)` — the names only exist in the source.
    const named = line.match(/constructor\([^)]*?\boptions\??:\s*([^,)]+)/);
    if (named && className && srcDestructured.has(className)) {
      out.push({
        className,
        destructured: srcDestructured.get(className),
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
    // Coverage today is 2, and that is the honest number: this only inspects a
    // class whose *constructor* takes an options object the emitted declaration
    // names. Helpers whose constructors take positional arguments
    // (`PowerQueue(0)`, `PowerTimedCache(ttl, …)`) and the per-method option
    // objects are out of scope. Extending it means attributing each
    // destructuring to the parameter whose type the declaration gives, which is
    // worth doing but is a real parser rather than a regex - and a check that
    // over-reports is worse than a narrow one, because it trains people to
    // ignore it.
    expect(surfacesChecked).toBeGreaterThanOrEqual(2);
  });

  it('no constructor destructures an option its published type does not declare', () => {
    // Verified to have teeth: deleting `policy` from PowerCacheOptions and
    // regenerating produces
    //   PowerCache (powerCache.d.ts): destructures `policy` but the published
    //   options type does not declare it
    expect(findings).toEqual([]);
  });
});
