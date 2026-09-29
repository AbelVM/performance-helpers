import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TEST-003: the pure-ESM branches of `WorkerAgnostic.js`, in a real ESM process.
 *
 * Every other test in this repository runs under vitest, where `require` exists.
 * Two branches sit behind `typeof require === 'undefined'` and are therefore
 * unreachable from here:
 *
 *   - `_loadNodeRequire`'s async `import("node:module")` / `createRequire` path
 *   - `getNodeWorkerCtor`'s throw
 *
 * Those two are the **pure-ESM Node path** — the very trap
 * `guides/troubleshooting.md` leads with, and the one DOC-001 names as the most
 * likely first-run failure in the whole library. Covering it "with a cleverer
 * assertion" is not possible: the branch is gated on the absence of a global.
 * The only honest way to reach it is a process that genuinely has no `require`,
 * so that is what this spawns.
 *
 * **Why a subprocess and not a stub.** The failure mode being tested is
 * environmental, and the environment is the thing under test. Deleting
 * `globalThis.require` inside vitest would exercise the branch while leaving
 * every other CJS interop in the process intact, so the test would pass in a way
 * that says nothing about a user's actual `node app.mjs`.
 *
 * The assertions pin the **exact** error text. DOC-001 records that two error
 * messages in the troubleshooting guide were invented and had to be corrected;
 * a guide is searched by its error strings, so a test that merely checked "it
 * threw" would let the next drift through.
 */
const WORKER_AGNOSTIC_URL = new URL('../src/helpers/WorkerAgnostic.js', import.meta.url).href;

/**
 * Run a snippet in a fresh real-ESM process and return its stdout lines.
 *
 * @param {string} body - Source appended after the import line.
 * @returns {string[]}
 */
function runInRealEsm(body) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-esm-'));
  try {
    const workerFile = join(dir, 'w.mjs');
    writeFileSync(workerFile, 'export default () => 42;\n');
    const script = join(dir, 'probe.mjs');
    writeFileSync(
      script,
      `import WorkerAgnostic, { preloadNode } from ${JSON.stringify(WORKER_AGNOSTIC_URL)};\n` +
        `const WORKER_FILE = ${JSON.stringify(workerFile)};\n` +
        body
    );
    const out = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.split('\n').filter((l) => l.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('WorkerAgnostic in a real pure-ESM process', () => {
  it('really has no require, or nothing here proves anything', () => {
    // The guard on the guard. If a future vitest config or Node version gave
    // this process a `require`, the remaining tests would pass while covering
    // nothing.
    const [line] = runInRealEsm('console.log("require=" + (typeof require));');
    expect(line).toBe('require=undefined');
  });

  it('throws the documented preload error for a string worker source', () => {
    // The headline of `guides/troubleshooting.md`. The exact text matters: that
    // guide is searched by its error strings.
    const [line] = runInRealEsm(
      "try { await WorkerAgnostic.create(WORKER_FILE); console.log('NO THROW'); }\n" +
        'catch (e) { console.log(e.message); }'
    );
    expect(line).toContain('WorkerAgnostic: Node worker_threads is not available synchronously');
    expect(line).toContain('await preloadNode()');
    expect(line).toContain('performance-helpers');
    expect(line).not.toBe('NO THROW');
  });

  it('resolves preloadNode, exercising the createRequire branch', () => {
    // Reaching the async `import("node:module")` path at all is the coverage
    // goal: it only runs when `typeof require === 'undefined'`.
    const [line] = runInRealEsm(
      "const r = await preloadNode();\nconsole.log('preload=' + typeof r);"
    );
    expect(line).toBe('preload=undefined');
  });

  it('creates a string-source worker after preloadNode', () => {
    // The end-to-end claim in the guide: the preload actually fixes it. If
    // `createRequire` resolved but `getNodeWorkerCtor` still threw, this is
    // where it would show.
    const [line] = runInRealEsm(
      'await preloadNode();\n' +
        "try { const w = await WorkerAgnostic.create(WORKER_FILE); console.log('created=' + (w != null)); await w.terminate?.(); }\n" +
        "catch (e) { console.log('FAILED: ' + e.message); }"
    );
    expect(line).toBe('created=true');
  });

  it('still honours an explicit globalThis.Worker without any preload', () => {
    // The other documented branch: setting the global is the alternative to
    // preloading, and it must not require it.
    const [line] = runInRealEsm(
      'globalThis.Worker = class { constructor() {} postMessage() {} terminate() {} };\n' +
        "try { const w = await WorkerAgnostic.create(WORKER_FILE); console.log('created=' + (w != null)); }\n" +
        "catch (e) { console.log('FAILED: ' + e.message); }"
    );
    expect(line).toBe('created=true');
  });

  it('accepts a factory function with no preload and no global', () => {
    // A third documented path: passing a function removes the problem instead
    // of paying for it. Worth pinning, because it is the fix the guide
    // recommends first and it needs neither of the other two.
    const [line] = runInRealEsm(
      'const factory = () => ({ postMessage() {}, terminate() {} });\n' +
        "try { const w = await WorkerAgnostic.create(factory); console.log('created=' + (w != null)); }\n" +
        "catch (e) { console.log('FAILED: ' + e.message); }"
    );
    expect(line).toBe('created=true');
  });

  it('keeps the guide and the thrown error in step', () => {
    // The regression guard for DOC-001 specifically: that entry records two
    // invented error strings in the troubleshooting guide, corrected after the
    // fact. This asserts the guide quotes an error this class actually throws,
    // so a future edit to either side fails here rather than in a user's
    // search box.
    const [thrown] = runInRealEsm(
      "try { await WorkerAgnostic.create(WORKER_FILE); console.log('NO THROW'); }\n" +
        'catch (e) { console.log(e.message); }'
    );
    const guide = readFileSync(
      fileURLToPath(new URL('../guides/troubleshooting.md', import.meta.url)),
      'utf8'
    );
    // The guide must at least point at the same remedy.
    expect(guide).toContain('preloadNode');
    expect(guide).toContain('require');
    // And the specific phrase the guide tells people to look for.
    expect(guide).toContain('not available synchronously');
    expect(thrown).toContain('not available synchronously');
  });
});
