/**
 * Shared loader for the UMD-bundle tests.
 *
 * Ten `umd.bundle.*.test.js` files each used to repeat the same ~50-line
 * bootstrap: import `fs`/`child_process`/`vm`, resolve `dist/`, shell out to
 * `npm run build` if the file was missing, read the source, hand-assemble a
 * browser-like sandbox, `vm.createContext`, `vm.runInContext`, and then dig the
 * library global out of the sandbox with a four-clause expression repeated as a
 * string literal in every file.
 *
 * That is ~450 duplicated lines and three flake sources:
 *
 * 1. `execSync('npm run build')` ran up to five times *within a single test
 *    file* - a full Vite build per file, and per call.
 * 2. The build was triggered by the tests themselves, so whether a test ran
 *    against fresh or stale `dist/` depended on filesystem state.
 * 3. The sandbox and the global-extraction expression drifted between files.
 *
 * This module centralises all of it. The build happens once, in
 * `test/globalSetup.js`, before any test runs — and **this module no longer
 * builds anything**, which is the fourth and worst of those flake sources. See
 * {@link loadBundleCode}.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { vi } from 'vitest';

const DIST_FILE = path.resolve(process.cwd(), 'dist', 'performance-helpers.js');

let cachedCode = null;

/**
 * Return the UMD bundle's source, built once by `test/globalSetup.js`.
 *
 * **This used to build the bundle itself if `dist/` was missing**, on the stated
 * grounds that it is "kept for running a single test file directly without the
 * global setup". That fallback is the reason `npm run verify` step 5 was flaky,
 * and it is worth being precise about why, because the justification looks
 * reasonable and is not:
 *
 * - **It is unreachable by design.** This module imports `vitest`, so it is
 *   vitest-only, and `vitest run <one file>` still runs `globalSetup`. There is
 *   no supported path that reaches the fallback.
 * - **When it *did* run, it ran concurrently.** `globalSetup` deletes `dist/`
 *   before building, on the good grounds that a stale bundle is "the same flake
 *   wearing a different hat". So every parallel worker whose file reached the
 *   fallback started its own full Vite build into a directory another build was
 *   rewriting. Symptoms: `ENOENT: dist/performance-helpers.js`, and
 *   `test/index.test.js` reporting `.cjs must exist`.
 * - **It made the failure unreproducible.** Restoring `vitest.config.js` from
 *   `HEAD` and re-running produced *ten* failures where the same tree produced
 *   five a moment earlier — a gate whose result depends on timing teaches people
 *   to retry it.
 *
 * So the failure mode now names itself instead of silently rebuilding.
 *
 * @returns {string} The UMD bundle source.
 * @throws {Error} If the bundle is absent, naming `globalSetup` as the builder.
 */
export function loadBundleCode() {
  if (cachedCode !== null) return cachedCode;
  try {
    cachedCode = readFileSync(DIST_FILE, 'utf8');
  } catch (cause) {
    throw new Error(
      `umd-bundle: ${DIST_FILE} is missing or unreadable. It is built once per run by ` +
        'test/globalSetup.js, which runs before any test file - including a single file. ' +
        'Nothing here builds it, on purpose: a fallback that builds on demand races every ' +
        "other worker's build into the same directory. Run the suite through vitest.",
      { cause }
    );
  }
  return cachedCode;
}

/** @returns {string} Absolute path of the bundle under test. */
export function bundlePath() {
  return DIST_FILE;
}

/**
 * Build a browser-like sandbox for the bundle.
 *
 * `globalThis`, `window`, `self` and `global` all point at the same object, so
 * the UMD wrapper finds the same global whichever one it probes. A fresh
 * `globalThis` per sandbox is deliberate: it keeps state from leaking between
 * tests, which is a cross-realm-`instanceof` hazard the old copies documented
 * around inconsistently.
 *
 * @param {Object} [extra] - Extra properties to merge onto the sandbox.
 * @returns {Object} The sandbox object, ready for `vm.createContext`.
 */
export function createSandbox(extra = {}) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextEncoder,
    TextDecoder,
    structuredClone,
    queueMicrotask,
    globalThis: {},
    ...extra,
  };
  sandbox.window = sandbox.globalThis;
  sandbox.self = sandbox.globalThis;
  sandbox.global = sandbox.globalThis;
  return sandbox;
}

/**
 * The UMD wrapper's global, whichever name it published under.
 *
 * Kept as one function rather than a string literal repeated in every test, so
 * a change to the bundle's global name is a one-line fix.
 */
const LIB_LOOKUP = `
  (typeof globalThis !== 'undefined' && (globalThis.PerformanceHelpers || globalThis.performanceHelpers))
  || (typeof PerformanceHelpers !== 'undefined' && (PerformanceHelpers || performanceHelpers))
  || this.PerformanceHelpers || this.performanceHelpers
`;

/**
 * Create a fresh context with the bundle loaded.
 *
 * @param {Object} [options]
 * @param {Object} [options.sandbox] - Overrides from {@link createSandbox}.
 * @returns {{ctx:Object, lib:Object, sandbox:Object}} The VM context, the
 *   bundle's exported library object, and the sandbox.
 */
export function createBundleContext({ sandbox: extra = {} } = {}) {
  const code = loadBundleCode();
  const sandbox = createSandbox(extra);
  const ctx = vm.createContext(sandbox);
  vm.runInContext(code, ctx, { filename: DIST_FILE });

  const lib = vm.runInContext(LIB_LOOKUP, ctx, { filename: DIST_FILE });
  if (!lib || typeof lib !== 'object') {
    throw new Error(
      'umd-bundle: the bundle did not publish a global. Expected PerformanceHelpers on globalThis.'
    );
  }
  // Publish the library as a *global of the context* so a snippet passed to
  // `evalInBundle` can just write `lib.PowerCache`. Assigning to the
  // contextified sandbox is what makes it visible inside the VM;
  // `sandbox.globalThis` is a plain object the sandbox shadows the real
  // globalThis with, so it is set too for the UMD wrapper's own probe.
  sandbox.lib = lib;
  sandbox.globalThis.lib = lib;
  return { ctx, lib, sandbox };
}

/**
 * Evaluate an expression in an existing bundle context.
 *
 * @param {Object} ctx - Context from {@link createBundleContext}.
 * @param {string} expression - JavaScript source to evaluate.
 * @returns {*} The expression's value.
 */
export function evalInBundle(ctx, expression) {
  return vm.runInContext(expression, ctx, { filename: DIST_FILE });
}

/**
 * Wait for an asynchronous reply from inside the bundle.
 *
 * The UMD tests drive a real `PowerPool` inside a `vm` context, so a reply
 * arrives on a later turn. Four test files used to handle that with
 * `await new Promise((r) => setTimeout(r, 50))` — a fixed guess in both
 * directions: it added 200 ms to the suite, and on a loaded machine it was a
 * coin flip whether the reply had landed. The failure mode is the bad one: a
 * slow run reads a summary before the reply arrives and asserts on an empty
 * array.
 *
 * Polling for the actual condition removes both. `vi.waitFor` retries until the
 * callback stops throwing, and its error names the expression, so a genuine
 * timeout says *what* never arrived instead of reporting a count mismatch
 * several lines later.
 *
 * The default timeout is 2000ms rather than 5000 deliberately: it has to be
 * comfortably under vitest's own 5000ms per-test limit, or the *test* timeout
 * fires first and the caller sees "Test timed out" instead of the message
 * naming the reply that never arrived.
 *
 * @param {Object} ctx - A context from {@link createBundleContext}.
 * @param {string} expression - A JavaScript expression evaluated in that context.
 * @param {Object} [options]
 * @param {number} [options.expected=1] - Minimum value the expression must reach.
 * @param {number} [options.timeout=2000] - Give up after this many ms.
 * @param {number} [options.interval=5] - Poll this often, in ms.
 * @param {string} [options.description] - What is being waited for, in the error.
 * @returns {Promise<number>} The final value of the expression.
 */
export async function waitForBundleValue(
  ctx,
  expression,
  { expected = 1, timeout = 2000, interval = 5, description = 'a reply' } = {}
) {
  let last;
  try {
    await vi.waitFor(
      () => {
        last = vm.runInContext(expression, ctx, { filename: DIST_FILE });
        if (!Number.isFinite(Number(last)) || Number(last) < expected) {
          throw new Error(`got ${String(last)}, need >= ${expected}`);
        }
      },
      { timeout, interval }
    );
  } catch (err) {
    // Re-throw with the description attached. `vi.waitFor`'s own `onTimeout`
    // option is not honoured in this vitest version, so the wrapper is the only
    // way the caller learns *which* reply never arrived rather than just
    // "got 0, need >= 1" - which says what failed but not what.
    throw new Error(
      `timed out after ${timeout}ms waiting for ${description} ` +
        `(stuck at ${String(last)}, need >= ${expected})`,
      { cause: err }
    );
  }
  return Number(last);
}

/**
 * The canonical "the pool has replied" probe for a context that pushes onto
 * `__received`.
 *
 * @param {Object} ctx
 * @param {string} [name] - The array name the test pushed onto.
 * @returns {string} An expression for {@link waitForBundleValue}.
 */
export function receivedCountExpression(name = '__received') {
  return `(this.${name} && this.${name}.length) || 0`;
}
