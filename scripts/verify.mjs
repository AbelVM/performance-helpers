#!/usr/bin/env node
/**
 * The verification gate, as one ordered list with one owner.
 *
 * ## Why this exists
 *
 * `ci.yml` used to maintain its own hand-written list of `npm run` steps instead
 * of calling this, and the two lists drifted: CI ran neither `test:types` nor
 * `check:bundle`, for as long as both existed. The generated `types/*.d.ts` were
 * therefore compiled only on maintainers' machines, and a bundle missing 70 of
 * its 72 exports would have passed. Both are the kind of gap that is invisible
 * until a release, which is the worst time to find one.
 *
 * So the list lives here, and CI calls it. Adding a check means adding it once.
 *
 * ## Why not an env-var substitution in `package.json`
 *
 * `npm run ${VERIFY_TEST:-test}` is the obvious one-liner and it is not portable:
 * `cmd.exe`, which npm uses on Windows by default, does not expand `${VAR:-x}`.
 * A contributor on Windows would get a failing gate on a clean tree, and the
 * usual response to that is to stop running it. Node is already required, and it
 * runs the same on every platform this package supports.
 *
 * ## The one documented difference
 *
 * CI passes `VERIFY_TEST=test:coverage`, because the thresholds configured in
 * `vitest.config.js` only apply under `--coverage` — `npm test` on its own does
 * not enforce them. That substitution is the *only* intended difference between
 * what a maintainer runs and what CI runs; everything else is identical, in the
 * same order.
 *
 * ## Usage
 *
 * ```sh
 * npm run verify                          # the local gate
 * VERIFY_TEST=test:coverage npm run verify  # what CI runs
 * ```
 *
 * @module scripts/verify
 */

import { spawnSync } from 'node:child_process';

/**
 * The gate, in order. Each entry is an `npm run` script name.
 *
 * Order matters in three places and nowhere else:
 * - `test:types` compiles `types/*.d.ts`, so it needs them to be present (they
 *   are committed) and it is more meaningful after nothing in particular.
 * - `check:bundle` reads `dist/`, so `build` must precede it.
 * - `types:generate` then `types:drift` is the sync check: regenerate, then
 *   require the tree to be unchanged, which is the only way a forgotten
 *   regeneration gets caught. `types:drift` reads `git status --porcelain`
 *   rather than `git diff`, so it also catches an **untracked** declaration —
 *   a newly added source file whose `.d.ts` was never generated. `git diff`
 *   compares to the index and is blind to that, and the pre-commit hook masks
 *   it locally, so the only places that see it are `--no-verify`, a squash bot,
 *   and a fresh clone — which reports it as a confusing "cannot find module"
 *   from `test:types` rather than as "commit types/".
 * - `docs:drift` is the same idea for the generated API reference, and it is
 *   the one check here that **rewrites a committed tree before comparing it**,
 *   because `typedoc.json` sets `cleanOutputDir: true` and there is no
 *   incremental mode to diff against. It runs last, after `types:generate`, so
 *   a tree `docs/` was generated from is the one `types/` was generated from.
 * - `docs:claims` sits between `types:drift` and `docs:drift` because it reads the
 *   **generated** declarations: it compares the option names a guide documents
 *   against `types/helpers/*.d.ts`. Before `types:generate` it would compare
 *   against a stale tree and report drift that has already been fixed. It also
 *   checks `llms.txt`, which nothing else reads at all. See the script's docblock
 *   for the two shipped defects it was written for; both had passed every other
 *   gate.
 *   It is last rather than earlier for a second reason: it is the slowest step
 *   by an order of magnitude, and when it fails it is never the interesting
 *   failure.
 * - `check:barrel` is **first**, before `lock:sync`, and it is the one step whose
 *   failure makes every later step meaningless. `src/index.js` once carried four
 *   duplicate `export { default as … }` lines from a concurrent edit; the build
 *   failed, `test/globalSetup.js` shells out to the build, so it failed, so every
 *   test file that imports the barrel failed to load — ~300 confusing per-file
 *   errors instead of one clear one, at the cost of a full suite run to discover.
 *   It imports the module rather than parsing it, because a duplicate export is
 *   syntactically valid and only fails at link time. See `scripts/check-barrel.mjs`.
 *
 * @type {string[]}
 */
const STEPS = [
  // A barrel that does not load is the one failure that makes every other gate
  // meaningless, so it goes before everything — including `lock:sync`, which is
  // about the installed tree rather than the source.
  'check:barrel',
  // The lock file and `package.json` agreeing is the one thing `verify` cannot
  // assume, because everything below runs against an already-installed tree.
  //
  // `husky` and `lint-staged` were added to `package.json` in a5999eb and the
  // lock file was never regenerated, so `npm ci` failed outright — 47 missing
  // packages — and it stayed invisible here indefinitely, because the local
  // `node_modules` had both installed and the pre-commit hook kept running. Only
  // a clean checkout noticed. `npm ci --dry-run` is that same sync check: it
  // resolves the tree without writing to it, needs no network, and finishes in
  // well under a second.
  'lock:sync',
  'lint',
  // Swappable. See the module docblock: the only intended difference between
  // the local gate and CI.
  process.env.VERIFY_TEST || 'test',
  'test:types',
  'typecheck:ratchet',
  'build',
  'check:bundle',
  'types:generate',
  'types:drift',
  'docs:claims',
  'docs:drift',
];

const label = process.env.VERIFY_TEST ? `verify (test: ${process.env.VERIFY_TEST})` : 'verify';
console.log(`${label}: ${STEPS.length} steps\n`);

for (const [index, step] of STEPS.entries()) {
  const position = `${index + 1}/${STEPS.length}`;
  console.log(`[${position}] npm run ${step}`);
  const result = spawnSync('npm', ['run', step], { stdio: 'inherit', shell: false });

  if (result.error) {
    console.error(`\nverify: could not run "${step}": ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    // Naming the step is the point. A gate that exits 1 without saying which
    // step failed sends the reader to the scrollback. The count is derived, not
    // written down: it said "eight" for as long as there were eight, which is
    // the same class of hardcoded total that drifts the moment a step is added.
    console.error(
      `\nverify: FAILED at step ${position} — "npm run ${step}" exited ${result.status}. ` +
        `${STEPS.length - index - 1} later step(s) did not run.`
    );
    process.exit(result.status ?? 1);
  }
}

console.log(`\n${label}: ok — ${STEPS.length}/${STEPS.length} steps passed.`);
