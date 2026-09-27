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
 * This module centralises all of it. The build itself now happens once, in
 * `test/globalSetup.js`, before any test runs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import vm from 'node:vm';
import path from 'node:path';

const DIST_FILE = path.resolve(process.cwd(), 'dist', 'performance-helpers.js');

let cachedCode = null;

/**
 * Build the UMD bundle if it is missing, then return its source.
 *
 * Normally called after `globalSetup` has already built it, so this is a cheap
 * synchronous read. The build fallback is kept for running a single test file
 * directly without the global setup.
 *
 * @returns {string} The UMD bundle source.
 */
export function loadBundleCode() {
  if (cachedCode !== null) return cachedCode;
  if (!existsSync(DIST_FILE)) {
    execSync('npm run build', { stdio: 'inherit' });
  }
  cachedCode = readFileSync(DIST_FILE, 'utf8');
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
