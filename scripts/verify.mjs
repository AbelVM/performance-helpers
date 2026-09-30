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
 *
 * @type {string[]}
 */
const STEPS = [
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
    // Naming the step is the point. A gate that exits 1 without saying which of
    // eight steps failed sends the reader to the scrollback.
    console.error(
      `\nverify: FAILED at step ${position} — "npm run ${step}" exited ${result.status}. ` +
        `${STEPS.length - index - 1} later step(s) did not run.`
    );
    process.exit(result.status ?? 1);
  }
}

console.log(`\n${label}: ok — ${STEPS.length}/${STEPS.length} steps passed.`);
