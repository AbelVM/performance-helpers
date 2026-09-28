#!/usr/bin/env node
'use strict';

/**
 * Type-debt ratchet (CFG-004).
 *
 * The audit asked for a pre-publish hook that runs lint + typecheck + test. Lint
 * and test are green, so they gate directly. Typecheck is not, and cannot be for
 * some time: `tsconfig.check.json` turns on `checkJs` over a JSDoc that has
 * never been type-checked, and `tsconfig.types.json` compiles the generated
 * declarations as a downstream consumer. Together they report a few hundred
 * pre-existing errors that no single change is responsible for.
 *
 * Gating on "zero errors" would mean the hook can never pass, and a hook that
 * can never pass is the same as no hook: `prepublishOnly` was effectively dead
 * before this script, because `test:types` failed and aborted the publish.
 * Dropping the type checks entirely would be worse - 593 errors would rot in
 * silence, which is exactly how BUG-002 (`frameEncodedJson` documented but
 * never exported) shipped.
 *
 * So the type checks run, and they gate on *direction*: the count may fall, but
 * it may not rise. That is checkable today, and it turns the debt into a
 * measurable series instead of an anecdote.
 *
 *   node scripts/typecheck-ratchet.cjs            # the gate
 *   node scripts/typecheck-ratchet.cjs --verbose  # ... with full tsc output
 *   node scripts/typecheck-ratchet.cjs --update   # print the new BASELINE line
 *
 * @see .github/workflows/ci.yml, package.json "prepublishOnly"
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

/**
 * The ceiling this repository is allowed to reach. Lower it whenever you fix
 * some. `scripts/typecheck-ratchet.cjs --update` prints the replacement line.
 *
 * 587 = `tsconfig.check.json` (internal `checkJs` debt, pre-existing)
 *  28 = `tsconfig.types.json` (consumer-visible; every one of these is a real
 *       promise the package breaks, so they get fixed first)
 *
 * This ceiling was raised once, from 593, and the reason matters: the +22 were
 * not introduced by the change that raised it. `assertLimit` was declared
 * `@returns {number|any}`, which TypeScript collapses to `any`, and `any`
 * satisfies every downstream use - so it was hiding 25 real null-safety
 * diagnostics across `powerBatch`, `powerCache`, `powerQueue`,
 * `powerSlidingWindow` and `powerThrottle` (QUAL-008). Declaring the truthful
 * `number | null | undefined` made them countable, and it also stopped seven
 * public fields emitting as `any` in the shipped `types/*.d.ts`. The net is
 * worse-looking and better-informed: the debt is now visible and ratchets down
 * from 615. Restoring the `any` to keep the number small would be trading the
 * published types for a prettier metric.
 */
const BASELINE = 615;

const PROJECTS = [
  { label: 'checkJs (tsconfig.check.json)', project: 'tsconfig.check.json' },
  { label: 'consumer (tsconfig.types.json)', project: 'tsconfig.types.json' },
];

// tsc reports `path(line,col): error TS1234: message`. Continuation lines of a
// multi-line diagnostic do not match, so counting matches counts diagnostics.
const DIAGNOSTIC = /^\S.*\(\d+,\d+\): error TS\d+:/;

const repoRoot = path.resolve(__dirname, '..');
const tsc = require.resolve('typescript/bin/tsc');
const verbose = process.argv.includes('--verbose');
const update = process.argv.includes('--update');

function countDiagnostics(output) {
  let n = 0;
  for (const line of output.split('\n')) if (DIAGNOSTIC.test(line)) n += 1;
  return n;
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
  total += count;
  results.push({ label, project, count, output });

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

if (total > BASELINE) {
  process.stderr.write(
    `\nType-debt ratchet FAILED: ${total} errors, ceiling is ${BASELINE} (+${total - BASELINE}).\n` +
      'New type errors must not ship. Fix them, or - if the new file is itself\n' +
      'known debt - raise the ceiling deliberately with --update and say why in\n' +
      'review.md. `npm run typecheck` and `npm run test:types` print the detail.\n'
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
  process.stdout.write(
    `\nType debt fell by ${BASELINE - total} (${BASELINE} -> ${total}).\n` +
      'Re-baseline with: npm run typecheck:ratchet -- --update\n'
  );
}

process.stdout.write('Type-debt ratchet passed.\n');
