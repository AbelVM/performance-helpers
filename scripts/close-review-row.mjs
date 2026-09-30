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

import { readFileSync, writeFileSync } from 'node:fs';
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
const merged = unescape(oldNote).replace(/\s*$/, '') + ' ' + note;

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
writeFileSync(REVIEW, lines.join('\n'));
console.log(`close-review-row: ${id} -> ${status}`);
