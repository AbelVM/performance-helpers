/**
 * The gate that runs the gates.
 *
 * `scripts/verify.mjs` exists because the project's own history had two
 * divergent lists of checks: `ci.yml` kept its own copy, and the copies drifted
 * until CI was running neither `test:types` nor `check:bundle`. This file is
 * about the two failure modes that produced that, and about the check just
 * added to it.
 *
 * **A step name that is not a script.** `verify.mjs` runs each entry with
 * `npm run <name>`. A typo, or a step whose script was renamed, is not a
 * skipped check — it is a gate that exits non-zero with `npm ERR! Missing
 * script`, which reads as "the gate is broken" rather than "someone renamed
 * something", and the fastest response to that is to stop running it. Nothing
 * else in the gate would notice, because the gate is the thing doing the
 * running.
 *
 * **`docs:drift` is the one step that rewrites a committed tree.** Every other
 * step either reads or writes a build artifact it then checks against a
 * committed twin. This one deletes and regenerates `docs/` — 1.7 MB, ~100
 * files — and *then* asks whether the committed copy matched. That is a
 * property worth pinning rather than discovering, especially because
 * `typedoc.json` sets `cleanOutputDir: true`: there is no incremental mode, so
 * the regeneration is destructive and unconditional by design.
 *
 * Assertions are on the script's own text and on `package.json`, both tracked
 * files. Nothing here runs `typedoc` — a test that shells out to a 2 s,
 * 100-file generator to prove a string is present is a slow way to read a
 * string. The *behaviour* of the drift check is exercised separately, by
 * committing a stale `docs/` and observing the step fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const verifySource = readFileSync(join(ROOT, 'scripts/verify.mjs'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const scripts = pkg.scripts;

/** The step names in `verify.mjs`'s `STEPS` array, in order. */
const steps = [
  ...(verifySource.match(/const STEPS = \[([\s\S]*?)\];/)?.[1].matchAll(/'([a-z:-]+)'/g) ?? []),
].map((m) => m[1]);

describe('verify.mjs', () => {
  it('parses a non-empty step list out of the source', () => {
    // If the array's shape ever changes, every assertion below would pass
    // vacuously against an empty list. This is the guard for the guard.
    expect(steps.length).toBeGreaterThan(0);
    expect(steps).toContain('lint');
  });

  it('runs only scripts that exist', () => {
    const missing = steps.filter((name) => !(name in scripts));
    expect(
      missing,
      'verify.mjs runs these with `npm run`, so a missing script is a gate that\n' +
        'exits 1 with "Missing script" rather than a skipped check. Either add the\n' +
        'script or remove the step.'
    ).toEqual([]);
  });

  it('runs the checks it exists to guarantee', () => {
    // The two CI once dropped, and the one added most recently. Named
    // individually because "the list is non-empty" passed while both of these
    // were missing from it.
    expect(steps).toContain('test:types');
    expect(steps).toContain('check:bundle');
    expect(steps).toContain('types:drift');
    expect(steps).toContain('docs:drift');
  });

  it('regenerates before it checks, for both generated trees', () => {
    // Order is the whole mechanism. A `drift` step ahead of its `generate`
    // step would compare a committed tree against itself and pass forever.
    expect(steps.indexOf('types:generate')).toBeLessThan(steps.indexOf('types:drift'));
    expect(steps.indexOf('types:generate')).toBeLessThan(steps.indexOf('docs:drift'));
  });

  it('puts docs:drift last, since it is the slowest and the least informative failure', () => {
    expect(steps.at(-1)).toBe('docs:drift');
  });

  it('does not hardcode its own step count in the failure message', () => {
    // It said "which of eight steps failed" for as long as there were eight.
    // The count is now derived, because a hardcoded total is the same class of
    // thing that drifts the moment a step is added.
    const message = verifySource.slice(verifySource.indexOf('verify: FAILED'));
    expect(message).not.toMatch(/\b(eight|nine|seven|ten|6|7|8|9|10)\b/);
    expect(message).toContain('${STEPS.length - index - 1}');
  });
});

describe('docs:drift', () => {
  it('regenerates docs/ before comparing it', () => {
    // typedoc.json sets `cleanOutputDir: true`, so a bare `git diff -- docs`
    // would pass forever: nothing else in the workflow ever writes `docs/`, and
    // a JSDoc change that is never regenerated is invisible to it.
    expect(scripts['docs:drift']).toContain('npm run docs');
    expect(scripts['docs:drift']).toContain('-- docs');
  });

  it('fails on untracked pages as well as modified ones', () => {
    // Mirrors `types:drift`. `git diff` compares to the index and is blind to
    // a new page that was never committed, and the pre-commit hook masks that
    // locally — so the only places that see it are `--no-verify`, a squash bot
    // and a fresh clone.
    expect(scripts['docs:drift']).toContain('ls-files --others');
  });

  it('scopes both checks to docs/ and nothing else', () => {
    // A `-- docs` that lost its path argument would fail on every file in the
    // tree, which reads as "the tree is dirty" and is indistinguishable from a
    // real failure.
    const scoped = scripts['docs:drift'].match(/-- docs/g) ?? [];
    expect(scoped.length).toBeGreaterThanOrEqual(3); // diff --quiet, status, ls-files
  });
});
