import { existsSync } from 'node:fs';
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
 * @returns {void}
 */
export function setup() {
  const distFile = path.resolve(process.cwd(), 'dist', 'performance-helpers.js');
  if (existsSync(distFile)) return;
  execSync('npm run build', { stdio: 'inherit' });
}

/**
 * Nothing to tear down: the build output is a plain directory of files that the
 * rest of the suite also reads.
 * @returns {void}
 */
export function teardown() {}
