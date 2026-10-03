import { existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

/**
 * Vitest global setup.
 *
 * Builds the UMD bundle **once**, before any test runs. The ten
 * `umd.bundle.*.test.js` files used to each shell out to `npm run build` if
 * `dist/` was missing - up to five times inside a single file - which was both
 * slow and a flake source, because whether a test ran against a fresh bundle
 * depended on filesystem state.
 *
 * It still builds only once, but now it **always** builds. Skipping the build
 * when `dist/` already exists is the same flake wearing a different hat: the
 * bundle is not in git, so a stale one survives across runs and the suite
 * silently tests yesterday's `src/`.
 *
 * That is not hypothetical. `test/umd.bundle.test.js` compared a framed
 * `PowerPool` message with `JSON.stringify()`, which is correct against the
 * pre-2.0 bundle and wrong against a fresh one, and the suite stayed green for
 * as long as nobody happened to rebuild `dist/`. A fresh CI checkout has no
 * `dist/`, so CI was the only environment where the test was honest - and it
 * was red there.
 *
 * @returns {void}
 */
export function setup() {
  chooseFastCheckSeed();
  const distFile = path.resolve(process.cwd(), 'dist', 'performance-helpers.js');
  // Delete rather than overwrite: `vite build` leaves stale artifacts behind
  // when an entry is renamed, and the loader would happily read them.
  if (existsSync(distFile))
    rmSync(path.resolve(process.cwd(), 'dist'), { recursive: true, force: true });
  execSync('npm run build', { stdio: 'inherit' });
  if (!existsSync(distFile)) {
    throw new Error(`globalSetup: \`npm run build\` did not produce ${distFile}`);
  }
}

/**
 * Pick one fast-check seed for the whole run and announce it.
 *
 * Eleven test files generate properties and, before this, none pinned a seed -
 * so a property that failed once could not be reproduced. Replaying the failing
 * file by hand is only useful with the seed, which is why it is printed.
 *
 * Decided here rather than in the per-worker setup file for two reasons: this
 * runs exactly once, so the line is printed once instead of once per worker, and
 * setting `process.env` here means every worker inherits the *same* seed, so a
 * failure can be replayed in isolation and still match what CI saw.
 *
 * Chosen per run rather than fixed. A fixed seed would make every run cover the
 * same ground and let a rare counterexample go unexercised indefinitely; a
 * random one would be irreproducible. This varies and is announced.
 *
 * @returns {void}
 */
function chooseFastCheckSeed() {
  if (process.env.FAST_CHECK_SEED === undefined)
    process.env.FAST_CHECK_SEED = String(Date.now() % 2 ** 31);
  // `process.stdout` rather than `console`: vitest does not surface console
  // output from a setup file, and this line is worthless if it never appears.
  process.stdout.write(
    `[fast-check] seed=${process.env.FAST_CHECK_SEED} (replay with FAST_CHECK_SEED=<n>)\n`
  );
}

/**
 * Nothing to tear down: the build output is a plain directory of files that the
 * rest of the suite also reads.
 * @returns {void}
 */
export function teardown() {}
