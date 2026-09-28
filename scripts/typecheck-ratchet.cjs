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
 *   node scripts/typecheck-ratchet.cjs            # the gate
 *   node scripts/typecheck-ratchet.cjs --verbose  # ... with full tsc output
 *   node scripts/typecheck-ratchet.cjs --update   # print the new BASELINE line
 *
 * When the internal count reaches zero, delete this script and add
 * `npm run typecheck` to `verify` directly. It is scaffolding for a check that
 * is not yet honest, not a permanent fixture.
 *
 * @see .github/workflows/ci.yml, package.json "verify"
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

/**
 * The ceiling this repository is allowed to reach. Lower it whenever you fix
 * some. `scripts/typecheck-ratchet.cjs --update` prints the replacement line.
 *
 * 437 = `tsconfig.check.json`, internal `checkJs` debt, all pre-existing.
 *
 * The history of this number is worth keeping, because the wrong move was
 * available three times and taken none of them.
 *
 * It started at 593 (563 internal + 30 consumer). Raising the JSDoc return type
 * of `assertLimit` off `number|any` - which TypeScript collapses to `any`, and
 * `any` satisfies everything - took it to 615, because it stopped hiding 25 real
 * null-safety diagnostics (QUAL-009). The tempting response was to put the `any`
 * back and keep the number small; that trades the published types for a prettier
 * metric, so instead the ceiling was raised to match reality and the finding was
 * filed.
 *
 * QUAL-009 was then fixed, the declarations stopped leaking `@types/node`, the
 * duplicated `PowerCacheOptions` list was deleted, and the consumer project went
 * 30 -> 0 - at which point it stopped being debt and became a gate. 542 is
 * below the 593 this started at, and the consumer column is no longer here at
 * all.
 */
const BASELINE = 437;

const PROJECTS = [{ label: 'checkJs (tsconfig.check.json)', project: 'tsconfig.check.json' }];

// tsc reports `path(line,col): error TS1234: message`. Continuation lines of a
// multi-line diagnostic do not match, so counting matches counts diagnostics.
const DIAGNOSTIC = /^\S.*\(\d+,\d+\): error TS\d+:/;

// Grammar-level diagnostics. If any of these appear, tsc could not *parse* the
// file, and a file that does not parse produces no semantic errors either - so
// the count falls without anything having been fixed. This is not theoretical:
// while landing the WorkerLike typedef, an inserted JSDoc block swallowed the
// `/**` opener of the next one, `jsdoc-types.js` stopped parsing, and the
// reported total dropped from 515 to 62. That looked like a 453-error win and
// was entirely fake. A count that can go *down* for the wrong reason is the
// only way this gate can lie, so it refuses to.
const SYNTAX =
  /error TS(1002|1003|1005|1006|1010|1011|1109|1128|1131|1135|1136|1160|1161|1206|1243|1244|1245|1258|1358|1434|1435):/;

// A large drop without a matching reduction elsewhere is also suspicious, but it
// cannot be detected from a single run - `previousCount` below is only a
// threshold on the same run, not history. Kept deliberately conservative.
const implausibleDropFraction = 0.5;
const implausibleDropFloor = 50;

const repoRoot = path.resolve(__dirname, '..');
const tsc = require.resolve('typescript/bin/tsc');
const verbose = process.argv.includes('--verbose');
const update = process.argv.includes('--update');

function countDiagnostics(output) {
  let n = 0;
  for (const line of output.split('\n')) if (DIAGNOSTIC.test(line)) n += 1;
  return n;
}

function findSyntaxErrors(output) {
  const found = [];
  for (const line of output.split('\n')) {
    if (DIAGNOSTIC.test(line) && SYNTAX.test(line)) {
      found.push(line.trim());
    }
  }
  return found;
}

const results = [];
let total = 0;

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
  const count = countDiagnostics(output);
  const syntax = findSyntaxErrors(output);
  total += count;
  results.push({ label, project, count, syntax, output });

  if (verbose) {
    process.stdout.write(output);
  } else {
    // Enough to see the shape of the debt, short enough to keep a CI log
    // readable. Full output is one `--verbose` (or the underlying script) away.
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

for (const { label, project, count } of results) {
  process.stdout.write(`  ${String(count).padStart(4)}  ${label}  (${project})\n`);
}
process.stdout.write(`  ${String(total).padStart(4)}  total, ceiling ${BASELINE}\n`);

// A file that does not parse reports no semantic errors, so the count *falls*
// while the file is actually more broken than it was. Fail before the count is
// believed.
const syntaxErrors = results.flatMap((r) => r.syntax);
if (syntaxErrors.length) {
  process.stderr.write(
    `\nType-debt ratchet FAILED: ${syntaxErrors.length} syntax/parse error(s). A file that\n` +
      'does not parse reports no semantic errors either, so the diagnostic count\n' +
      'above is understated and must not be used to lower the ceiling:\n\n'
  );
  for (const line of syntaxErrors.slice(0, 20)) process.stderr.write(`    ${line}\n`);
  if (syntaxErrors.length > 20) {
    process.stderr.write(`    ... and ${syntaxErrors.length - 20} more\n`);
  }
  process.exit(1);
}

if (total > BASELINE) {
  process.stderr.write(
    `\nType-debt ratchet FAILED: ${total} errors, ceiling is ${BASELINE} (+${total - BASELINE}).\n` +
      'New type errors must not ship. Fix them, or - if the new file is itself\n' +
      'known debt - raise the ceiling deliberately with --update and say why in\n' +
      'review.md. `npm run typecheck` prints the detail.\n'
  );
  process.exit(1);
}

if (update) {
  process.stdout.write(
    `\nRe-baseline line for scripts/typecheck-ratchet.cjs:\n  const BASELINE = ${total};\n`
  );
} else if (total < BASELINE) {
  // Not a failure - the debt went down and the ceiling should follow it, or the
  // ratchet slowly stops being a ratchet.
  const drop = BASELINE - total;
  const fraction = drop / BASELINE;
  if (drop >= implausibleDropFloor && fraction >= implausibleDropFraction) {
    // Half the debt vanishing in one run is almost always a broken parse, a
    // mis-measured project, or a `types/` regeneration that changed which
    // files are included - not a good afternoon. Make a human look.
    process.stderr.write(
      `\nHeads up: the count fell by ${drop} (${(fraction * 100) | 0}%) in one run.\n` +
        'That is a large enough jump to be worth confirming against the diff\n' +
        'before re-baselining. Check `git diff --stat -- types` and that no file\n' +
        'was left unparseable.\n'
    );
  }
  process.stdout.write(
    `\nType debt fell by ${drop} (${BASELINE} -> ${total}).\n` +
      'Re-baseline with: npm run typecheck:ratchet -- --update\n'
  );
}

process.stdout.write('Type-debt ratchet passed.\n');
