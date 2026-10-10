#!/usr/bin/env node
/**
 * AUD-033 — the `AGENTS.md` benchmark list must not drift from `bench/claims.js`.
 *
 * ## The problem
 *
 * `AGENTS.md` carries a hand-maintained list of the `bench/claims.js` modes, and
 * the file itself says so: *"The list above is still hand-maintained and can
 * drift, so treat `bench/claims.js` as the authority on what exists."* That
 * sentence is an admission that the list is wrong sometimes, and a reader has no
 * way to tell when. It was wrong at the time this gate was written: the file
 * listed 25 modes against 28 in the table, missing the three geospatial ones.
 *
 * A stale list is worse than a missing one, because it reads as complete. Seven
 * modes were once reachable only by reading `bench/claims.js` and were named in
 * neither `AGENTS.md` nor `bench/README.md` — which is the same failure, and the
 * reason the list exists at all.
 *
 * ## Why the probe, and not a parse of `MODES`
 *
 * The authority is `bench/claims.js`'s `MODES` table, and the file already
 * exposes it: its unknown-mode error is *generated* from that table, so running
 * it with a nonsense mode prints every mode that actually works. This gate uses
 * that as its source of truth rather than re-deriving it.
 *
 * The alternatives were both worse. Exporting `MODES` would make a benchmark
 * harness a library surface, for the benefit of one check. Regex-parsing the
 * object literal out of the source would work until someone reformatted it —
 * and a gate that silently stops matching is the failure mode this project has
 * already recorded several times. The probe cannot drift, because it *is* the
 * code's own answer.
 *
 * @module scripts/check-bench-list
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const AGENTS = path.join(repoRoot, 'AGENTS.md');
const CLAIMS = path.join(repoRoot, 'bench', 'claims.js');

/** A mode name that cannot collide with a real one. */
const PROBE = '__audit_no_such_mode__';

/**
 * The modes `bench/claims.js` actually has, from its own generated error.
 * @returns {string[]}
 */
function modesFromClaims() {
  let out;
  try {
    // The harness exits 1 for an unknown mode, so a non-zero status is the
    // expected path here — `execFileSync` throws on it, and the message we want
    // is on stderr.
    out = execFileSync(process.execPath, [CLAIMS, PROBE], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const match = out.match(/Use one of:\s*(.+?)\.?\s*$/m);
  if (!match) {
    console.error('check-bench-list: could not read the mode list from bench/claims.js.');
    console.error('  Its unknown-mode error no longer prints "Use one of: ...", so this');
    console.error('  gate has nothing to compare against. That is a real change to the');
    console.error('  harness and this script needs updating with it — not a reason to skip.');
    process.exit(1);
  }
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

/**
 * The modes `AGENTS.md` documents, from its `node bench/claims.js <mode>` lines.
 * @returns {string[]}
 */
function modesFromAgents() {
  const text = readFileSync(AGENTS, 'utf8');
  const found = new Set();
  // Every documented invocation is `node bench/claims.js <mode>`, optionally
  // followed by a `#` comment. Anchored on the full command so a prose mention
  // of the file without a mode is not miscounted as one.
  const re = /node bench\/claims\.js\s+([a-zA-Z][a-zA-Z0-9]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[1]);
  return [...found].sort();
}

const actual = modesFromClaims();
const documented = modesFromAgents();

const missing = actual.filter((mode) => !documented.includes(mode));
const stale = documented.filter((mode) => !actual.includes(mode));

if (missing.length === 0 && stale.length === 0) {
  console.log(
    `check-bench-list: ok — AGENTS.md documents all ${actual.length} bench/claims.js modes.`
  );
  process.exit(0);
}

console.error('check-bench-list: AGENTS.md and bench/claims.js disagree.\n');
if (missing.length) {
  console.error(`  In bench/claims.js but NOT documented in AGENTS.md (${missing.length}):`);
  for (const mode of missing) console.error(`    + ${mode}`);
  console.error('    A mode nobody can find from the docs is a mode nobody runs.');
}
if (stale.length) {
  console.error(`\n  Documented in AGENTS.md but NOT in bench/claims.js (${stale.length}):`);
  for (const mode of stale) console.error(`    - ${mode}`);
  console.error('    A documented mode that does not exist fails on first use.');
}
console.error(
  `\n  ${actual.length} modes exist; ${documented.length} are documented.` +
    '\n  Update the list in AGENTS.md, or remove the entry that no longer runs.'
);
process.exit(1);
