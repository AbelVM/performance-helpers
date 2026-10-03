#!/usr/bin/env node
/**
 * Two-phase, check-then-write editor for files more than one session touches.
 *
 * **Why this exists.** `review.md` has been corrupted twice in this project and
 * `review_04.md` once, all three times the same way: a session reads a file,
 * composes an edit, and writes the whole thing back — discarding whatever landed
 * in between. `AGENTS.md` records the same failure for `git stash`, and
 * `scripts/close-review-row.mjs` grew an mtime guard for the same reason. **That
 * guard protects the script; it does not protect the habit**, and the incident
 * that prompted this tool was a hand-written edit that reverted a concurrent
 * session's section renumbering.
 *
 * A single-phase check cannot fix this. Comparing the file against a snapshot
 * taken inside the same process only catches a write that lands *during* the run,
 * and the dangerous case is the one where it landed *before*. So the snapshot has
 * to be taken by the caller, separately, and handed back as a digest.
 *
 *   safe-edit snapshot --file review_04.md
 *   safe-edit apply    --file review_04.md --expect <digest> --patch <module.mjs>
 *
 * `apply` refuses with exit 1 if the file's digest is not the expected one, so a
 * stale edit fails loudly instead of silently reverting someone. On success it
 * prints what changed and **keeps the backup**, so the edit is reversible with
 * `cp` — never with `git stash`, per AGENTS.md.
 *
 * A patch module receives the current text and returns the replacement:
 *
 *   export default function patch(text) {
 *     const anchor = 'the exact line to find';
 *     if (!text.includes(anchor)) throw new Error('anchor absent - re-snapshot');
 *     return text.replace(anchor, `${anchor}\nnew line`);
 *   }
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const digestOf = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const USAGE = `safe-edit - check-then-write for shared files

  safe-edit snapshot --file <path>
  safe-edit apply    --file <path> --expect <sha256> --patch <module.mjs>

Exit codes: 0 ok, 1 refused or failed. There is no partial write.
`;

function snapshot(args) {
  const file = args.file;
  if (!file) throw new Error('snapshot requires --file');
  const resolved = path.resolve(file);
  const digest = digestOf(resolved);
  // A sibling .bak rather than a /tmp path: a backup that is not next to its
  // file is a backup that gets separated from it.
  const backup = `${resolved}.bak-${digest.slice(0, 12)}`;
  copyFileSync(resolved, backup);
  console.log(`file    : ${file}`);
  console.log(`digest  : ${digest}`);
  console.log(`backup  : ${backup}`);
  return 0;
}

async function apply(args) {
  const { file, expect, patch: patchPath } = args;
  if (!file || !expect || !patchPath) {
    throw new Error('apply requires --file, --expect and --patch');
  }
  const resolved = path.resolve(file);

  // The whole point: refuse before touching anything, comparing against the
  // digest the caller snapshotted rather than one taken now.
  const actual = digestOf(resolved);
  if (actual !== expect) {
    console.error(
      `safe-edit: REFUSED - ${file} changed since the snapshot.\n` +
        `  expected ${expect}\n  actual   ${actual}\n` +
        'Someone else wrote to this file. Your edit was composed against a version ' +
        'that no longer exists, and applying it would revert their work.\n' +
        'Re-read the file, re-compose the patch, and apply again with the new digest.'
    );
    return 1;
  }

  const before = readFileSync(resolved, 'utf8');
  const mod = await import(pathToFileURL(path.resolve(patchPath)).href);
  const patch = mod.default ?? mod.patch;
  if (typeof patch !== 'function') {
    throw new Error(`${patchPath} must export a default function (text) => text`);
  }
  const after = patch(before);

  if (typeof after !== 'string') throw new Error('patch did not return a string');
  if (after === before) {
    // A patch that changes nothing almost always means its anchor moved. Writing
    // anyway would look like success and leave the file unedited.
    console.error(
      'safe-edit: REFUSED - the patch produced no change.\n' +
        '  Its anchor is probably stale. Re-read the file and re-compose it.'
    );
    return 1;
  }
  if (after.includes('\0')) {
    console.error('safe-edit: REFUSED - the patched text contains a NUL byte.');
    return 1;
  }

  writeFileSync(resolved, after);
  console.log(`safe-edit: applied to ${file}`);
  console.log(`  before : ${expect}`);
  console.log(`  after  : ${digestOf(resolved)}`);
  console.log(`  revert : cp <the .bak file it printed> ${file}`);
  console.log('  The backup is kept on purpose. Do NOT use `git stash` to undo this -');
  console.log('  AGENTS.md records it conflicting on a dirty tree and losing work.');
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 1) {
  if (!rest[i].startsWith('--')) continue;
  args[rest[i].slice(2)] = rest[i + 1];
  i += 1;
}

try {
  if (cmd === 'snapshot') process.exit(snapshot(args));
  else if (cmd === 'apply') process.exit(await apply(args));
  else {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(`safe-edit: ${err.message}`);
  process.exit(1);
}
