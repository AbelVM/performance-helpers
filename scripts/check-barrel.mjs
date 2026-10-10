#!/usr/bin/env node
/**
 * Step 0 of the gate: the barrel must load.
 *
 * ## Why this exists
 *
 * `src/index.js` carried four duplicate `export { default as … }` lines from an
 * in-flight concurrent edit. `powerQueue.js` exports only a *named* `PowerQueue`
 * — there is no `default` — so that line was a link error, and the other three
 * were duplicate named exports. The result was
 * `SyntaxError: Duplicate export of 'PowerDeduplication'` on import.
 *
 * `npm run build` failed, `test/globalSetup.js` shells out to `npm run build`,
 * so it failed, so **every test file that imports the barrel failed to load**.
 * The suite did not report "mostly green with a few failures" — it could not
 * run at all, and the failure surfaced as ~300 confusing per-file errors rather
 * than one clear one.
 *
 * ## Why an import and not `node --check`
 *
 * A duplicate export is **syntactically valid**. `node --check` parses the file
 * and passes; the error is raised at *link* time, when the module's export
 * names are resolved. So a parse gate would have been green through the exact
 * defect it was written for. Importing the module is the only check that sees
 * both classes: syntax errors, duplicate exports, and a `default as` re-export
 * of a symbol that has no default.
 *
 * It is also the cheapest possible version of the same signal — one process,
 * no build, no test run — which is why it belongs *before* `build` rather than
 * after it.
 *
 * @module scripts/check-barrel
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const barrel = pathToFileURL(path.join(here, '..', 'src', 'index.js')).href;

let mod;
try {
  mod = await import(barrel);
} catch (err) {
  console.error(
    'check-barrel: src/index.js does not load — every gate below this one is meaningless.\n'
  );
  console.error(`  ${err && err.message ? err.message : err}`);
  console.error('\nA barrel that does not parse or link breaks the build, which breaks');
  console.error('test/globalSetup.js, which breaks every test file that imports it.');
  process.exit(1);
}

const names = Object.keys(mod).sort();
if (names.length === 0) {
  console.error('check-barrel: src/index.js loaded but exported nothing.');
  process.exit(1);
}

// The count is reported, not asserted. `test/apiSurface.test.js` pins the exact
// list deliberately; a second, drifting copy of that number here would be the
// "a type written twice is wrong once" failure this project has already been
// bitten by. What this gate owns is *loadability*, and it says so.
console.log(`check-barrel: ok — src/index.js loads with ${names.length} exports.`);
