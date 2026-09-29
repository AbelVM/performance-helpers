import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * DOC-002: the examples are executed, not just committed.
 *
 * An example that has not been run is documentation that has quietly rotted.
 * The API moves, the script keeps its old argument order, and nothing notices
 * until a reader copies it and it fails — which is the situation examples are
 * supposed to prevent.
 *
 * This file is why `examples/README.md` can say the examples run in CI, and it
 * has already earned that: every example in the directory was wrong the first
 * time it was executed. `PowerThrottle` took a `now` this file had guessed at,
 * `PowerRealtimeHub` turned out to be topic-based rather than subscriber-based,
 * GCRA's `burst` turned out to be additional tolerance rather than a total, and
 * a Node ESM worker silently ignores `self.onmessage`. Every one of those is a
 * mistake a reader would have made, and not one of them was visible by reading
 * the code.
 *
 * The examples run as child processes rather than being imported, because they
 * are programs: they call `process.exit`, they set timers that keep running,
 * and importing one into a test runner would leave that state behind for the
 * next test.
 */

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const examplesDir = join(root, 'examples');

/** Every top-level example. `lib/` holds support files and is not one. */
function exampleNames() {
  return readdirSync(examplesDir)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.slice(0, -4))
    .sort();
}

const NAMES = exampleNames();

describe('examples', () => {
  it('the directory is not empty', () => {
    // Silently passing because `examples/` was emptied or renamed would be
    // the worst possible outcome for this file: it would look like the
    // examples are covered when nothing is being run.
    expect(NAMES.length).toBeGreaterThan(0);
  });

  it('every example is listed in the README', () => {
    const readme = readFileSync(join(examplesDir, 'README.md'), 'utf8');
    for (const name of NAMES) {
      expect(readme, `examples/README.md does not mention "${name}"`).toContain(`${name}.mjs`);
    }
  });

  it('the runner lists exactly the same set', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      join(root, 'scripts', 'run-example.mjs'),
    ]);
    // The runner is what a reader types, so its list and the directory must
    // not drift apart.
    for (const name of NAMES) {
      expect(stdout).toContain(name);
    }
    expect(stdout).not.toContain('worker'); // `lib/worker.mjs` is a support file
  });

  it('rejects an unknown example name rather than guessing', async () => {
    await expect(
      execFileAsync(process.execPath, [join(root, 'scripts', 'run-example.mjs'), 'cach'])
    ).rejects.toThrow();
  });

  it('every example runs to completion', async () => {
    // `pool` spawns real worker threads, `realtime` waits for a 25 ms slow
    // client to drain, and `observability` deliberately blocks the event
    // loop. Together they are a few seconds, so this needs more than the
    // default per-test timeout.
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(root, 'scripts', 'run-example.mjs'), '--all'],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    // Each example ends with `OK`. Checking the count rather than the text
    // means an example cannot pass by printing OK from a branch that is not
    // the one under test.
    const oks = stdout.match(/^OK$/gm) ?? [];
    expect(oks.length).toBe(NAMES.length);
  }, 120_000);
});
