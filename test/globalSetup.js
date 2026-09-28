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
 * Nothing to tear down: the build output is a plain directory of files that the
 * rest of the suite also reads.
 * @returns {void}
 */
export function teardown() {}
