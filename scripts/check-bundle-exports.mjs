#!/usr/bin/env node
/**
 * Verify that the built UMD/CJS bundle matches the ESM source entry point.
 *
 * This check has to live outside vitest, and finding out why was most of the
 * work. `test/globalSetup.js` is registered in `vitest.config.js` and deletes
 * and rebuilds `dist/` before any test runs, from the same `src/` that a test
 * would import. So **within a test run the bundle and the source cannot
 * diverge** - not because a comparison is broken, but because nothing is being
 * compared that could differ. Three separate in-test attempts at a parity
 * assertion (a `require()`-key comparison, and two text-based ones) all passed
 * no matter what was done to either side, for exactly this reason. An
 * assertion that cannot fail reads as coverage while providing none, so it was
 * removed from the suite rather than left in place.
 *
 * Here, in a plain Node process, the comparison is real: this runs *after* the
 * build and reads both artefacts from disk, so a bundle that is missing an
 * export, or one that is stale relative to `src/`, is caught.
 *
 * Run via `npm run check:bundle`, and as part of `npm run verify`.
 *
 * @module scripts/check-bundle-exports
 */

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/**
 * The package's named exports, read from the ESM entry.
 *
 * Read as *text* rather than imported, so this script reports on the file as it
 * is on disk and has no module cache of its own to be confused by.
 *
 * @returns {string[]} Sorted export names declared by `src/index.js`.
 */
function esmExportNames() {
  const source = readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  const names = new Set();
  // `export { a, b as c } from './x.js'` and `export { a }` share a shape.
  for (const match of source.matchAll(/export\s*\{([^}]*)\}\s*from/g)) {
    for (const part of match[1].split(',')) {
      const token = part.trim().replace(/^type\s+/, '');
      if (!token) continue;
      const asMatch = token.match(/\bas\s+(\S+)$/);
      names.add(asMatch ? asMatch[1] : token);
    }
  }
  return [...names].sort();
}

/**
 * The build outputs declared by `package.json`, with their conditions.
 *
 * Only the `require` condition points at a built artefact (a `.cjs` bundle);
 * `import` and `default` point straight at `src/index.js`, which is the *input*
 * to the build and is checked separately as the reference side of the
 * comparison.
 *
 * @returns {{cond: string, rel: string}[]}
 */
function bundleTargets() {
  const out = [];
  const root = pkg.exports?.['.'];
  if (root && typeof root === 'object' && typeof root.require === 'string') {
    out.push({ cond: 'require', rel: root.require });
  }
  return out;
}

/**
 * The newest `.js` file under `src/`, as a repo-relative path.
 *
 * GATE-013. The staleness check used to compare the bundle against exactly two
 * files — the CJS bundle's counterpart and `src/index.js` — while printing
 * "the bundle is not older than its **sources**". Those are not the same claim.
 * The bundle is built from every module under `src/`, so a helper edited after the
 * last build (`src/helpers/powerCache.js`, say) left the bundle stale and the
 * check passed: the success message was describing a scan that did not happen, and
 * the failure message named only `src/index.js` even when the CJS bundle was the
 * older file.
 *
 * Walking the tree is the fix rather than reworded, because a message that admits
 * what it checks would still be the wrong answer — the gate is supposed to catch a
 * stale bundle, and a stale bundle is defined by *any* input being newer.
 *
 * @returns {{rel: string, mtimeMs: number}|null} The newest source, or `null`.
 */
function newestSourceFile() {
  let newest = null;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const { mtimeMs } = statSync(abs);
        if (!newest || mtimeMs > newest.mtimeMs) {
          newest = { rel: path.relative(ROOT, abs), mtimeMs };
        }
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return newest;
}

const esmNames = esmExportNames();
if (!esmNames.length) {
  console.error('check:bundle: could not read any export from src/index.js');
  process.exit(1);
}

console.log(`check:bundle: ${esmNames.length} export(s) declared by src/index.js`);

let failed = false;

for (const { cond, rel } of bundleTargets()) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) {
    console.error(`  ✗ ${cond} -> ${rel}: missing. Run \`npm run build\` first.`);
    failed = true;
    continue;
  }
  const source = readFileSync(abs, 'utf8');
  // Word-boundary match so `PowerGCRA` does not satisfy `PowerGCRAExtra`.
  const missing = esmNames.filter((n) => !new RegExp(`\\b${n}\\b`).test(source));
  if (missing.length) {
    console.error(`  ✗ ${cond} -> ${rel}: missing ${missing.length} export(s):`);
    for (const name of missing) console.error(`      ${name}`);
    failed = true;
    continue;
  }
  console.log(`  ✓ ${cond} -> ${rel}: all ${esmNames.length} names present`);
}

// Staleness: a bundle older than the newest file it is built from is testing
// dead code, which no name comparison would reveal.
const bundleMtimes = bundleTargets()
  .map(({ rel }) => path.join(ROOT, rel))
  .filter((abs) => existsSync(abs))
  .map((abs) => statSync(abs).mtimeMs);
const sourceMtimes = [...bundleTargets(), { rel: 'src/index.js' }]
  .map(({ rel }) => path.join(ROOT, rel))
  .filter((abs) => existsSync(abs) && abs.endsWith('.js'))
  .map((abs) => statSync(abs).mtimeMs);
const newestInSrc = newestSourceFile();
if (newestInSrc) sourceMtimes.push(newestInSrc.mtimeMs);

if (bundleMtimes.length && sourceMtimes.length) {
  const newestBundle = Math.max(...bundleMtimes);
  const newestSource = Math.max(...sourceMtimes);
  if (newestBundle < newestSource) {
    // Name the file that is actually newest, so "run npm run build" is preceded by
    // a statement about what was stale. Naming `src/index.js` unconditionally was
    // wrong in the common case: the helper is usually the newer file, and the
    // index has not been touched at all.
    const culprit =
      newestInSrc && newestInSrc.mtimeMs >= Math.max(...sourceMtimes)
        ? newestInSrc.rel
        : 'src/index.js';
    console.error(
      `  ✗ the bundle is older than ${culprit}. Every UMD test would be asserting` +
        '\n      against stale code. Run `npm run build`.'
    );
    failed = true;
  } else {
    console.log('  ✓ the bundle is not older than its sources');
  }
}

if (failed) {
  console.error('\ncheck:bundle: FAILED');
  process.exit(1);
}
console.log('\ncheck:bundle: ok');
