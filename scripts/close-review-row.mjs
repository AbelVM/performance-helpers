#!/usr/bin/env node
/**
 * Close an existing plan row in `review.md`, preserving every other cell.
 *
 * `--row` on `review-row.mjs` emits a whole row, so changing a status means
 * restating the task, priority, ROI, risk and effort too — and restating them
 * from memory is how a row silently acquires a typo in a column nobody was
 * looking at. This reads the existing row, splits it, replaces only the status
 * and appends to the notes, and re-emits it through the same validator, so a
 * malformed edit fails here rather than in the table.
 *
 *   node scripts/close-review-row.mjs --id RES-001 --note 'Done. ...'
 *   node scripts/close-review-row.mjs --id RES-001 --status '🟡' --note 'Partial.'
 *
 * @module scripts/close-review-row
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildRow, splitRow, COLUMNS } from './review-row.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVIEW = path.join(ROOT, 'review.md');

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const id = arg('--id');
const status = arg('--status') ?? '✅';
const note = arg('--note');
if (!id || !note) {
  console.error('usage: close-review-row.mjs --id <ID> [--status <mark>] --note <text>');
  process.exit(2);
}

// Read, edit one line, write the whole 465 KB file back — with no lock. That is
// a lost-update window, and it is not hypothetical: `review.md` is gitignored
// (so `git checkout` cannot undo a clobber) and more than one session has been
// editing it, which is how a concurrent sweep's rows survived alongside this
// one's only by luck of interleaving.
//
// The stat is taken **before** the read and re-taken **after** the edit, so a
// write that landed in between is caught rather than silently overwritten. It
// is a cheap optimistic-concurrency check, and it converts a silent data loss
// into a loud failure — the same principle as `review-row.mjs` making a stale
// status loud. A size change alone is not trusted: a same-length edit is
// possible, so mtime is compared too, and mtime resolution means a write inside
// the same tick can slip past — which is why the failure message tells the
// caller to re-read and re-apply rather than to retry blindly.
const before = statSync(REVIEW);
const lines = readFileSync(REVIEW, 'utf8').split('\n');
const idx = lines.findIndex((l) => l.startsWith(`| ${id} |`));
if (idx === -1) {
  console.error(`close-review-row: no row for ${id}`);
  process.exit(1);
}

const cells = splitRow(lines[idx]);
if (cells.length !== COLUMNS.length) {
  console.error(
    `close-review-row: ${id} has ${cells.length} cells, expected ${COLUMNS.length}: ${lines[idx]}`
  );
  process.exit(1);
}

const [cellId, , task, priority, roi, risk, effort, oldNote] = cells;
// `splitRow` leaves the escaping in place, because that is what the table means
// by the character. `buildRow` escapes again on the way out, so the round trip
// has to unescape in between or every `\|` in a note becomes `\\|` and the row
// renders a stray backslash.
const unescape = (s) => s.replaceAll('\\|', '|');
// Appended rather than replaced: the row's evidence — the reproduction, the
// measured number, the surviving mutant — is why a future reader believes the
// row was closed, and it does not go stale when the fix lands.
//
// **Collapse the note to a single line here, not in the caller.** `buildRow`'s
// own cell assertion does not catch a newline: `escapeCell` does not strip one,
// and a `\n` inside the note cell splits a *table row* across physical lines
// while the in-memory string still parses as 8 cells. On disk the first physical
// line then has one pipe too few, `splitRow` drops the trailing cell, and the
// note vanishes from the row — which is how WT-006 was found to be missing its
// trailing delimiter in the first place.
//
// This has now happened three times in this project (twice recorded in
// AGENTS.md, once here) and every instance came from a note drafted as more
// than one paragraph. `--note "$(cat file)"` preserves internal newlines and
// strips only trailing ones, so a note file written with a blank line between
// paragraphs reproduces it exactly. Flattening at the boundary is the one place
// it cannot be forgotten, and it is also why a paragraph break in a note
// arrives as a single space rather than being silently dropped.
const flatten = (s) =>
  String(s ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
const merged = `${unescape(oldNote).replace(/\s*$/, '')} ${flatten(note)}`.trim();

lines[idx] = buildRow({
  id: cellId,
  status,
  task: unescape(task),
  priority: unescape(priority),
  roi: unescape(roi),
  risk: unescape(risk),
  effort: unescape(effort),
  note: merged,
});
// Re-check before writing, not after: by the time a post-write stat runs the
// damage is already on disk.
const after = statSync(REVIEW);
if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
  console.error(
    `close-review-row: ${id} NOT written — review.md changed underneath this run ` +
      `(mtime ${before.mtimeMs} -> ${after.mtimeMs}, size ${before.size} -> ${after.size}). ` +
      'Another writer is active. Re-read the row and re-run; do not retry blindly, because ' +
      'the other session may have closed it already.'
  );
  process.exit(1);
}

writeFileSync(REVIEW, lines.join('\n'));
console.log(`close-review-row: ${id} -> ${status}`);
