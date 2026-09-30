#!/usr/bin/env node
'use strict';

/**
 * Type-debt ratchet (CFG-004).
 *
 * The audit asked for a pre-publish hook that runs lint + typecheck + test. Lint
 * and test are green, so they gate directly, and so is the consumer type test:
 * `tsconfig.types.json` compiles the generated declarations the way a
 * downstream TypeScript user would, and it is at **zero**, so `verify` runs it
 * directly rather than routing it through here. That check is the one that
 * protects the shipped `.d.ts`, and it is now a hard gate.
 *
 * What remains here is the internal `checkJs` project, which is not at zero and
 * cannot be fixed without a large unrelated change: it turns on `checkJs` over
 * JSDoc that has never been type-checked, and it reports a few hundred
 * pre-existing errors across every module. Gating on zero would mean the hook
 * can never pass, and a hook that can never pass is the same as no hook -
 * `prepublishOnly` was effectively dead before this script, because
 * `test:types` failed and aborted the publish. Dropping the check entirely
 * would be worse: 542 errors would rot in silence, which is exactly how
 * BUG-002 (`frameEncodedJson` documented but never exported) shipped.
 *
 * So the check runs, and it gates on *direction*: the count may fall, but it may
 * not rise. That is checkable today, and it turns the debt into a measurable
 * series instead of an anecdote.
 *
 *   node scripts/typecheck-ratchet.cjs                    # the gate
 *   node scripts/typecheck-ratchet.cjs --verbose          # ... with full tsc output
 *   node scripts/typecheck-ratchet.cjs --update           # print the values to record
 *   node scripts/typecheck-ratchet.cjs --raise --reason "..."   # record a higher ceiling
 *   node scripts/typecheck-ratchet.cjs --lower --reason "..."   # ... or a lower one
 *
 * The ceiling and the two safety floors live in
 * `scripts/typecheck-ratchet.json`, so moving one is a reviewable diff with a
 * justification rather than an edit to a constant that reads as a typo.
 *
 * ## What this is allowed to be wrong about
 *
 * A ratchet that measures nothing while reporting a number is worse than no
 * ratchet, because it is believed. Every number printed here is downstream of
 * `tsc`, so all three ways of measuring nothing are closed explicitly:
 *
 * - **tsc failed, and printed nothing countable.** A deleted config, or an
 *   `include` glob matching no files, exits non-zero with zero diagnostics. The
 *   old script never looked at `run.status`, so this reported `0`, took the
 *   "debt fell" branch, and printed *passed* while measuring nothing.
 * - **tsc loaded a subset of the source.** `--listFilesOnly` reports the program
 *   it actually built, and it is compared against every JavaScript file the
 *   repository has under `src`.
 * - **A file stopped parsing.** This is the one that bites, and it is the
 *   historical incident this script exists because of: an inserted JSDoc block
 *   swallowed the next one's opener, `jsdoc-types.js` stopped parsing, and the
 *   reported total fell from 515 to 62. That looked like a 453-error win and
 *   was entirely fake. A file that does not parse reports no semantic errors
 *   either, so the count *falls* while the code is more broken, and the only
 *   symptom is that the debt looks like progress.
 *
 * The defence used to be a list of 21 TypeScript grammar error codes. It could
 * not be maintained: 18 further codes escaped it, including `TS1110`, and as of
 * this writing it matched **0 of the 29 codes the project actually emits** — it
 * had never once fired on a real diagnostic, so it was guarding against a
 * failure mode it could not actually detect. A code range is not the answer
 * either: `TS1016` (a module-resolution error) and `TS18048` (a real semantic
 * null-check) sit either side of the `1xxx` boundary the range test would draw.
 *
 * What replaces it is a property of the *shape* of the output rather than of the
 * codes: a file that stops parsing stops reporting diagnostics, so it leaves the
 * set of files with diagnostics. The floor on that set's size catches it, and
 * cannot rot — a new file simply starts at zero and is not counted.
 *
 * @see .github/workflows/ci.yml, package.json "verify"
 */

const { spawnSync, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const repoRoot = path.resolve(__dirname, '..');
const configPath = path.join(__dirname, 'typecheck-ratchet.json');
const tsc = require.resolve('typescript/bin/tsc');

const verbose = process.argv.includes('--verbose');
const update = process.argv.includes('--update');
const raise = process.argv.includes('--raise');
const lower = process.argv.includes('--lower');
const reasonIndex = process.argv.indexOf('--reason');
const reason = reasonIndex === -1 ? undefined : process.argv[reasonIndex + 1];

const PROJECTS = [{ label: 'checkJs (tsconfig.check.json)', project: 'tsconfig.check.json' }];

// tsc reports `path(line,col): error TS1234: message`. Continuation lines of a
// multi-line diagnostic do not match, so counting matches counts diagnostics.
const DIAGNOSTIC = /^\S.*\(\d+,\d+\): error TS(\d+):/;

const implausibleDropFraction = 0.5;
const implausibleDropFloor = 50;

/**
 * @returns {{ceiling: number, minFilesWithDiagnostics: number, recordedAt: string, reason: string}}
 */
function readConfig() {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    process.stderr.write(
      `ratchet: cannot read ${path.relative(repoRoot, configPath)}: ${err.message}\n`
    );
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `ratchet: ${path.relative(repoRoot, configPath)} is not valid JSON: ${err.message}\n`
    );
    process.exit(2);
  }
  for (const key of ['ceiling', 'minFilesWithDiagnostics']) {
    if (!Number.isInteger(parsed[key])) {
      process.stderr.write(
        `ratchet: ${path.relative(repoRoot, configPath)} needs an integer \`${key}\`; ` +
          `found ${JSON.stringify(parsed[key])}.\n`
      );
      process.exit(2);
    }
  }
  return parsed;
}

/**
 * @param {string[]} names - Relative paths as `git ls-files` reports them.
 * @returns {Promise<string[]>}
 */
function listSourceFiles(names) {
  // `git ls-files` rather than a directory walk, so a file that is present but
  // untracked is *not* silently excluded from the check: an untracked file in
  // `src/` is one the author is about to commit, and this is the moment to
  // notice that tsc is not measuring it.
  try {
    return execFileSync('git', ['ls-files', '--', ...names], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.endsWith('.js'));
  } catch (err) {
    process.stderr.write(`ratchet: could not list source files: ${err.message}\n`);
    process.exit(2);
  }
  return [];
}

const config = readConfig();
const BASELINE = config.ceiling;
const MIN_FILES = config.minFilesWithDiagnostics;

const sourceFiles = listSourceFiles(['src/']);
if (sourceFiles.length === 0) {
  process.stderr.write('ratchet: `git ls-files src/` matched no .js files; refusing to measure.\n');
  process.exit(2);
}

function countDiagnostics(output) {
  const files = new Set();
  let n = 0;
  for (const line of output.split('\n')) {
    const match = line.match(DIAGNOSTIC);
    if (!match) continue;
    n += 1;
    files.add(line.slice(0, line.indexOf('(')));
  }
  return { n, files };
}

/**
 * The files tsc says it built, as paths relative to the repository root.
 *
 * @param {string} project
 * @returns {Set<string>}
 */
function programFiles(project) {
  const run = spawnSync(
    process.execPath,
    [tsc, '--noEmit', '--project', project, '--listFilesOnly'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (run.error) {
    process.stderr.write(
      `ratchet: could not list the program for ${project}: ${run.error.message}\n`
    );
    process.exit(2);
  }
  const out = new Set();
  for (const line of `${run.stdout || ''}${run.stderr || ''}`.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) continue;
    out.add(path.relative(repoRoot, trimmed));
  }
  return out;
}

const results = [];
let total = 0;
let failEarly = null;

for (const { label, project } of PROJECTS) {
  const run = spawnSync(process.execPath, [tsc, '--noEmit', '--project', project], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (run.error) {
    process.stderr.write(`ratchet: could not run tsc for ${project}: ${run.error.message}\n`);
    process.exit(2);
  }

  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const { n: count, files } = countDiagnostics(output);
  total += count;
  results.push({ label, project, count, files, output, status: run.status });

  // A non-zero exit is the *normal* case — that is what the debt is. The
  // failure is a non-zero exit with nothing countable to show for it, or a zero
  // exit from a project that cannot be at zero. Either way the count is not a
  // measurement, and reporting it as one is the lie this script exists to avoid.
  if (count === 0) {
    if (!failEarly) {
      failEarly =
        `ratchet: ${project} reported 0 diagnostics, which cannot be right.\n` +
        `  tsc exit status: ${run.status}\n` +
        (run.status === 0
          ? '  Exit 0 means tsc checked the project and found nothing. That is the\n' +
            '  state this project is furthest from, so the more likely reading is that\n' +
            '  the include glob matches no files, or `files` does not cover the source.\n'
          : '  A non-zero exit with nothing countable means tsc never got as far as\n' +
            '  checking: a deleted tsconfig, a bad compilerOptions entry, or a tsc\n' +
            '  that could not be resolved.\n') +
        '  Either way the total below is not a measurement, so nothing is reported.';
    }
  }

  if (verbose) {
    process.stdout.write(output);
  } else {
    const shown = output
      .split('\n')
      .filter((line) => DIAGNOSTIC.test(line))
      .slice(0, 5);
    for (const line of shown) process.stdout.write(`    ${line}\n`);
    if (count > shown.length) {
      process.stdout.write(`    ... and ${count - shown.length} more\n`);
    }
  }
}

for (const { label, project, count, status } of results) {
  process.stdout.write(
    `  ${String(count).padStart(4)}  ${label}  (${project}, tsc exit ${status})\n`
  );
}
const filesWithDiagnostics = new Set();
for (const r of results) for (const f of r.files) filesWithDiagnostics.add(f);
process.stdout.write(
  `  ${String(total).padStart(4)}  total, ceiling ${BASELINE}\n` +
    `  ${String(filesWithDiagnostics.size).padStart(4)}  files reporting, floor ${MIN_FILES}\n`
);

if (failEarly) {
  process.stderr.write(`\nType-debt ratchet FAILED:\n${failEarly}\n`);
  process.exit(1);
}

// Every source file must be in the program tsc built. A file that is present,
// tracked, and *not* being checked is a hole in the measurement, and it is
// invisible from the diagnostic count: a file tsc never loaded reports nothing.
for (const { project } of results) {
  const inProgram = programFiles(project);
  const missing = sourceFiles.filter((f) => !inProgram.has(f));
  if (missing.length) {
    process.stderr.write(
      `\nType-debt ratchet FAILED: ${missing.length} source file(s) are not in the program\n` +
        `tsc built for ${project}. A file that is not checked is not counted, so the\n` +
        'total above is optimistic by an unknown amount:\n\n'
    );
    for (const f of missing.slice(0, 20)) process.stderr.write(`    ${f}\n`);
    if (missing.length > 20) process.stderr.write(`    ... and ${missing.length - 20} more\n`);
    process.stderr.write(
      "\nCheck the project's `include`/`files` and that the path is not excluded.\n"
    );
    process.exit(1);
  }
}

// A file that stops parsing stops reporting diagnostics, so it leaves this set,
// and the aggregate count *falls* while the code is more broken. That is the
// historical incident: `jsdoc-types.js` stopped parsing, the total dropped from
// 515 to 62, and it read as a 453-error win.
//
// This cannot rot the way the code list it replaces did. A new file starts
// outside the set and is not counted; a file only leaves when it reaches zero
// diagnostics, which is the same event as lowering the ceiling, and both are
// recorded together.
if (filesWithDiagnostics.size < MIN_FILES) {
  process.stderr.write(
    `\nType-debt ratchet FAILED: only ${filesWithDiagnostics.size} file(s) report diagnostics,` +
      `\nfloor is ${MIN_FILES}.\n\n` +
      'A file that fails to parse reports no semantic errors either, so this means a\n' +
      'parse regression far more likely than a cleanup, and the count above is\n' +
      'understated rather than improved. Compare against the last run with --verbose.\n\n' +
      `  still reporting: ${[...filesWithDiagnostics].sort().join(', ')}\n\n` +
      'If the drop is real, record it: npm run typecheck:ratchet -- --lower --reason "..."\n'
  );
  process.exit(1);
}

if (raise || lower) {
  if (!reason) {
    process.stderr.write(
      `\nratchet: --${raise ? 'raise' : 'lower'} needs --reason "..." so the diff says why.\n`
    );
    process.exit(2);
  }
  if (raise && total < BASELINE) {
    process.stderr.write(
      `\nratchet: --raise asked to raise the ceiling to ${total}, which is *below* the\n` +
        `current ${BASELINE}. Use --lower, or leave it alone.\n`
    );
    process.exit(2);
  }
  if (lower && total > BASELINE) {
    process.stderr.write(
      `\nratchet: --lower asked to lower the ceiling to ${total}, which is *above* the\n` +
        `current ${BASELINE}. Use --raise, with a reason.\n`
    );
    process.exit(2);
  }
  const next = {
    ceiling: total,
    minFilesWithDiagnostics: Math.min(MIN_FILES, filesWithDiagnostics.size),
    recordedAt: new Date().toISOString().slice(0, 10),
    reason,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(
    `\nratchet: wrote ${path.relative(repoRoot, configPath)} — ceiling ${total}, ` +
      `files floor ${next.minFilesWithDiagnostics}.\n`
  );
  process.exit(0);
}

if (total > BASELINE) {
  process.stderr.write(
    `\nType-debt ratchet FAILED: ${total} errors, ceiling is ${BASELINE} (+${total - BASELINE}).\n` +
      'New type errors must not ship. Fix them, or - if the new file is itself\n' +
      'known debt - record the move deliberately:\n' +
      '  npm run typecheck:ratchet -- --raise --reason "..."\n' +
      'The ceiling lives in scripts/typecheck-ratchet.json, so the change is a diff.\n' +
      '`npm run typecheck` prints the detail.\n'
  );
  process.exit(1);
}

if (update) {
  process.stdout.write(
    '\nValues to record in scripts/typecheck-ratchet.json:\n' +
      `  "ceiling": ${total},\n` +
      `  "minFilesWithDiagnostics": ${Math.min(MIN_FILES, filesWithDiagnostics.size)}\n`
  );
} else if (total < BASELINE) {
  const drop = BASELINE - total;
  const fraction = drop / BASELINE;
  if (drop >= implausibleDropFloor && fraction >= implausibleDropFraction) {
    // Half the debt vanishing in one run is almost always a broken parse, a
    // mis-measured project, or a `types/` regeneration that changed which files
    // are included - not a good afternoon.
    //
    // This used to print advice and exit 0, which is the exact shape of the lie
    // this script exists to prevent: a headline drop is the one thing a ratchet
    // should never accept silently, and the only reason to keep going is that
    // the threshold is coarse enough to false-positive on a real cleanup. That
    // is what a human review is for.
    process.stderr.write(
      `\nType-debt ratchet FAILED: the count fell by ${drop} (${(fraction * 100) | 0}%) in one run.\n` +
        'A drop that size is far more likely a broken parse, a mis-measured project, or a\n' +
        '`types/` regeneration that changed which files are included than a good\n' +
        'afternoon — and a ratchet that accepts a headline drop silently is the thing\n' +
        'this script exists to prevent.\n\n' +
        'Confirm it against the diff. If it is real, record it:\n' +
        '  npm run typecheck:ratchet -- --lower --reason "..."\n'
    );
    process.exit(1);
  }
  process.stdout.write(
    `\nType debt fell by ${drop} (${BASELINE} -> ${total}).\n` +
      'Record it with: npm run typecheck:ratchet -- --lower --reason "..."\n'
  );
}

process.stdout.write('Type-debt ratchet passed.\n');
