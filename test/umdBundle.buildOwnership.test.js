/**
 * Exactly one place may build the UMD bundle: `test/globalSetup.js`.
 *
 * GATE-020. `npm run verify` step 5 — `VERIFY_TEST=test:coverage`, which is what
 * CI runs — was flaky: `ENOENT: dist/performance-helpers.js`,
 * `test/index.test.js` reporting `.cjs must exist`, and
 * `Command failed: npm run build`, at rates between one and ten failures on a
 * tree with nothing wrong in it. It was verified pre-existing by restoring
 * `vitest.config.js` from `HEAD` and reproducing, and *worse* there, which is
 * what identified timing rather than configuration as the variable.
 *
 * The cause was four fallback builds left behind by the fix `AGENTS.md` already
 * documents as complete. `globalSetup` builds once and **deletes `dist/` first**,
 * on the good grounds that a stale bundle is "the same flake wearing a different
 * hat" — so any worker that reached a fallback started a full Vite build into a
 * directory another build was rewriting. Three of the four sat in `umd.bundle.*`
 * files at import time or per-test, and one sat in the shared helper.
 *
 * **This asserts on the source rather than on timing, and that is the point.** The
 * regression is "a test builds the bundle", which is a structural fact with an
 * exact answer; the flake was its *symptom*, which has a variable one. A timing
 * assertion here would be the decoration this project deletes.
 *
 * Read as a class check rather than a site list: the four sites are named in the
 * failure message so a reintroduction says which file to look at, but the
 * assertion is the property, so a *fifth* site is caught too.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** The one file allowed to shell out to a build. */
const BUILDER = 'test/globalSetup.js';

/**
 * This file, which has to be excluded from its own scan.
 *
 * It necessarily contains the string it searches for, so a scan that does not
 * exempt it reports itself. That is not a corner case to design around — it is
 * the second false positive this check produced, after `commitGuard.test.js`
 * legitimately using `spawnSync` for git. Both times the fix was to make the
 * rule say what it means rather than to loosen it.
 */
const SELF = 'test/umdBundle.buildOwnership.test.js';

/**
 * Every `.js` file under `test/`, recursively.
 *
 * @returns {string[]} Paths relative to the repository root.
 */
function testFiles(dir = 'test') {
  const out = [];
  for (const entry of readdirSync(path.resolve(process.cwd(), dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...testFiles(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

/**
 * Source lines that would build the bundle, ignoring comments.
 *
 * Comments are excluded because the files that *had* the defect now describe it —
 * `globalSetup.js`'s own docstring names `npm run build` twice, and each patched
 * test file explains what it used to do. Stripping comments keeps the assertion
 * about behaviour and stops documentation of the fix from registering as a
 * reintroduction of it.
 *
 * **The match is `npm run build`, not `execSync`.** The first draft of this
 * matched `execSync|spawnSync` and immediately flagged two innocent files:
 * `test/commitGuard.test.js` shells out to **git**, and this file matches its own
 * regex literal. Both are the same mistake — testing for a *tool* rather than
 * for the *action*. The defect is "something rebuilds the bundle behind
 * globalSetup's back", and the build command is the only way to spell that.
 *
 * @param {string} source
 * @returns {string[]} The offending lines.
 */
function buildCallLines(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter((line) => line.includes('npm run build'));
}

describe('exactly one test file builds the UMD bundle', () => {
  it('only test/globalSetup.js shells out to a build', () => {
    // The whole defect in one assertion. The offender list is in the message
    // because a failure that says "something, somewhere" costs the next person
    // the ten minutes I just spent finding the fourth site by hand — my first
    // single-pattern search reported one file where there were four.
    const offenders = [];
    for (const file of testFiles()) {
      if (file === BUILDER || file === SELF) continue;
      const hits = buildCallLines(readFileSync(path.resolve(process.cwd(), file), 'utf8'));
      if (hits.length) offenders.push(`${file}: ${hits.join(' | ')}`);
    }
    expect(
      offenders,
      `Only ${BUILDER} may build. A test that builds races every other worker's build ` +
        'into the same directory, which is what made verify step 5 flaky. To run one test ' +
        'file against a fresh bundle, rebuild it yourself first — vitest already runs ' +
        `${BUILDER} for a single file.`
    ).toEqual([]);
  });

  it('globalSetup.js deletes dist/ before building, and still builds', () => {
    // The delete is load-bearing and looks like the bug: a stale `dist/` survives
    // across runs and the suite silently tests yesterday's `src/`, which is how
    // `test/umd.bundle.test.js` compared a framed `PowerPool` message against the
    // pre-2.0 bundle and stayed green for as long as nobody rebuilt. Removing it
    // would trade a flake for a silent wrong answer, so it is pinned here rather
    // than left to the next person reading the previous paragraph.
    const source = readFileSync(path.resolve(process.cwd(), BUILDER), 'utf8');
    // Matched per line rather than with one regex over the file: the call is
    // `rmSync(path.resolve(process.cwd(), 'dist'), { ... })`, and a `[^)]*`
    // between the parens cannot span `path.resolve`'s own closing one. The first
    // version of this assertion therefore never matched anything, which is the
    // failure mode where a guard looks like it is guarding.
    const removes = source
      .split('\n')
      .filter((line) => line.includes('rmSync') && line.includes("'dist'"));
    expect(removes.length).toBeGreaterThan(0);
    expect(buildCallLines(source).length).toBeGreaterThan(0);
  });

  it('the shared helper names globalSetup rather than building', () => {
    // The failure mode after the fix, which is the one a reader will hit: a
    // missing bundle used to rebuild silently, and now throws. It has to *say*
    // who builds it, or the next person to hit it in a fresh checkout adds the
    // fallback back.
    //
    // The `child_process` import is asserted separately from the build command
    // because the helper no longer needs `child_process` for anything, and an
    // unused import of it would be the first half of reintroducing the fallback.
    const source = readFileSync(path.resolve(process.cwd(), 'test/helpers/umdBundle.js'), 'utf8');
    expect(source).toMatch(/globalSetup/);
    expect(source).not.toMatch(/from 'node:child_process'/);
    expect(buildCallLines(source)).toEqual([]);
  });
});
