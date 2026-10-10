#!/usr/bin/env node
/**
 * Emit and validate rows of the implementation-plan table in `review.md`.
 *
 * `review.md` is a local working document — it is gitignored — and its plan is a
 * markdown table with **eight** columns: ID, Status, Task, Priority, ROI, Risk,
 * Effort, Notes. Two failure modes have broken that table repeatedly, both of
 * them silent:
 *
 *   1. A bare `|` inside prose. `Number(threshold) || 5` in a note splits the
 *      cell in two, and the row silently gains a column.
 *   2. Writing the long note into the *Priority* column instead of the last one.
 *      Every row looks plausible in the raw text; only the column count says
 *      otherwise.
 *
 * A blank line inside the table is a third, and it terminates the whole table,
 * so a single stray newline splits the plan in half.
 *
 * A fourth is a **stale status**, and it is the one `AGENTS.md` calls worse than
 * a missing row: a row whose note says the work is done while its status still
 * reads open. Nothing structural is wrong with it — the column count is right,
 * the prose is coherent, and the work really was done — so every other check here
 * passes and the table confidently sends someone to rebuild something that is
 * already built.
 *
 * It is not hypothetical. `RT-005` sat that way for four commits: a hand-rolled
 * edit wrote the note and left the status cell untouched, so the prose and the
 * marker disagreed and the row validator said everything was fine. The fix was
 * `scripts/close-review-row.mjs`, which existed to make exactly this edit
 * correctly, and which had not been used.
 *
 * This module makes all four loud:
 *
 *   node scripts/review-row.mjs --check                 validate the whole table
 *   node scripts/review-row.mjs --row '<json>'          print one checked row
 *
 * `--row` takes `{ id, status, task, priority, roi, risk, effort, note, ref }`
 * and prints the row to stdout, with every pipe inside a cell escaped and the
 * result asserted to be exactly eight cells. `--check` reports every malformed
 * row and every interior blank line at once, rather than the first one.
 *
 * @module scripts/review-row
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVIEW = path.join(ROOT, 'review.md');

/** Unescaped pipes are the cell delimiters; escaped ones are content. */
const UNESCAPED_PIPE = /(?<!\\)\|/;

/** Column names of the plan table, in order. Must match the header. */
export const COLUMNS = ['ID', 'Status', 'Task', 'Priority', 'ROI', 'Risk', 'Effort', 'Notes'];

/**
 * Escape the one character that can break a markdown table cell.
 * @param {string} s
 * @returns {string}
 */
export function escapeCell(s) {
  return String(s ?? '').replaceAll('|', '\\|');
}

/**
 * Split a table row into its cells, dropping the leading and trailing empties.
 * @param {string} line
 * @returns {string[]}
 */
export function splitRow(line) {
  return line
    .split(UNESCAPED_PIPE)
    .slice(1, -1)
    .map((c) => c.trim());
}

/**
 * Build one plan row, with the cell count asserted.
 *
 * @param {Object} spec
 * @param {string} spec.id
 * @param {string} spec.status - `✅`, `🟡`, `⬜` or `⟡`.
 * @param {string} spec.task
 * @param {string} spec.priority - e.g. `P1`.
 * @param {string} spec.roi
 * @param {string} spec.risk
 * @param {string} spec.effort - e.g. `40 LOC`.
 * @param {string} spec.note - The long prose. Pipes are escaped.
 * @param {string} [spec.ref] - Section reference, e.g. `§2.8.`; appended to the note.
 * @returns {string} The row, ready to replace the old one with.
 */
export function buildRow({ id, status, task, priority, roi, risk, effort, note, ref }) {
  for (const key of ['id', 'status', 'task', 'priority', 'roi', 'risk', 'effort']) {
    if (spec_missing(key, { id, status, task, priority, roi, risk, effort })) {
      throw new Error(`review-row: missing required field "${key}"`);
    }
  }
  const cells = [id, status, task, priority, roi, risk, effort];
  const noteCell = [escapeCell(note ?? '').trim(), ref ? `(${ref})` : ''].filter(Boolean).join(' ');
  cells.push(noteCell);
  const row = `| ${cells.map((c) => (c === noteCell ? c : escapeCell(c).trim())).join(' | ')} |`;
  const parsed = splitRow(row);
  if (parsed.length !== COLUMNS.length) {
    throw new Error(
      `review-row: built a row with ${parsed.length} cells, expected ` +
        `${COLUMNS.length} (${COLUMNS.join(', ')}). Something in the payload ` +
        'introduced a cell break - most likely a bare `|` that survived escaping.'
    );
  }
  return row;
}

/** Status marker for a row that is still to do. */
export const OPEN_MARKER = '⬜';

/**
 * Does this note claim the work is finished?
 *
 * Deliberately narrow. It matches the phrase this document's own closures use —
 * `Done,` or `Done.` as its own token — and nothing looser, because a gate that
 * fires on the word "done" anywhere in 130 rows of prose is a gate that gets
 * switched off.
 *
 * **Mutation-checked, and it passes.** Flipping a closed row (CACHE-004) back to
 * `⬜` while leaving its note's `Done.` claim in place makes `--check` fail with
 * exactly this message, so the guard is not merely unused — it detects the defect
 * it was written for. Its own history ("RT-005 sat that way for four commits") is
 * not that evidence; this is.
 *
 * **What it cannot detect, and no version of it can, is the seven rows that
 * really went stale this release.** Those were work that landed with the note
 * never edited — the note still described the code as absent, so there was no
 * completion claim in it for this guard to match. Distinguishing "the work landed"
 * from "the work is outstanding" requires reading `src/`, not the table, which is
 * why they were found by hand rather than by a gate. The cheap structural fix is
 * not a better matcher: it is that **`review.md` is gitignored, so the rule
 * "close the row in the same commit as the work" cannot be enforced by a
 * pre-commit hook at all** — git never sees the file. That is the actual reason
 * seven rows drifted, and it is a reason to rely on the discipline rather than on
 * another regex.
 *
 * @param {string} note
 * @returns {boolean}
 */
export function claimsCompletion(note) {
  return /(^|\s)Done[.,]/.test(String(note ?? ''));
}

/**
 * @param {string} key
 * @param {Object} values
 * @returns {boolean}
 */
function spec_missing(key, values) {
  return values[key] === undefined || values[key] === null || values[key] === '';
}

/**
 * Validate the whole plan table.
 *
 * Reports *every* problem, not the first: fixing a table one row per round trip
 * is how five separate breakages survived as long as they did.
 *
 * @param {string} text - Contents of `review.md`.
 * @returns {{rows: number, problems: string[]}}
 */
export function checkTable(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('| ID |') || l.startsWith('| Task ID |'));
  if (start === -1) return { rows: 0, problems: ['review.md: no `| ID |` header found'] };

  const headerCells = splitRow(lines[start]);
  if (headerCells.length !== COLUMNS.length) {
    return {
      rows: 0,
      problems: [
        `review.md:${start + 1}: header has ${headerCells.length} columns, ` +
          `expected ${COLUMNS.length} (${COLUMNS.join(', ')})`,
      ],
    };
  }

  const problems = [];
  let rows = 0;
  /** @type {string[][]} Every parsed row, in table order, for the histograms below. */
  const parsedRows = [];
  // Where each ID was first seen, so a repeat can name both lines. A duplicate
  // ID is invisible in a rendered table — markdown shows two perfectly
  // well-formed rows — and it is how a row ends up *shadowing* a real open item,
  // which is worse than either being absent.
  //
  // Found by doing it: a finding was filed as `RT-022`, which was already in use
  // by an unrelated open row about `SharedArrayBuffer` transfer lists, and
  // `--check` reported *clean*. A duplicate is neither a column-count problem nor
  // a header problem, so this validator had nothing to say about it.
  const seen = new Map();
  let i = start + 2; // skip header and separator
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('|')) {
      rows += 1;
      const cells = splitRow(line);
      parsedRows.push(cells);
      const rowId = (cells[0] ?? '').trim();
      if (rowId) {
        const first = seen.get(rowId);
        if (first === undefined) seen.set(rowId, i + 1);
        else {
          problems.push(
            `review.md:${i + 1}: duplicate ID ${rowId}, first seen on line ${first}. ` +
              'Two rows cannot be tracked by one identifier, and the second one ' +
              'shadows the first — check it is not a re-file of a row that already ' +
              'exists.'
          );
        }
      }
      if (cells.length !== COLUMNS.length) {
        const id = cells[0] ?? '(no id)';
        problems.push(
          `review.md:${i + 1}: ${id} has ${cells.length} cells, expected ` +
            `${COLUMNS.length}. Usually a bare \`|\` in the note, or the note ` +
            'written into the Priority column instead of last.'
        );
      } else if ((cells[1] ?? '').trim() === OPEN_MARKER && claimsCompletion(cells[7])) {
        // Only meaningful once the row splits into the right number of cells;
        // otherwise `cells[7]` is not the note and this would read nonsense.
        problems.push(
          `review.md:${i + 1}: ${rowId || '(no id)'} is marked open but its note ` +
            'claims the work is done. A stale row is worse than a missing one: it ' +
            'sends someone to rebuild something that is already built. If the work ' +
            'landed, set the status; if it did not, delete the claim. Use ' +
            '`scripts/close-review-row.mjs --id ' +
            `${rowId} --note '…'\`, which replaces the status and appends the note ` +
            'together.'
        );
      }
      i += 1;
      continue;
    }
    if (line.trim() === '') {
      // A blank line is only a problem if more table rows follow it.
      let j = i;
      while (j < lines.length && lines[j].trim() === '') j += 1;
      if (j < lines.length && lines[j].startsWith('|')) {
        problems.push(
          `review.md:${i + 1}: blank line inside the plan table — this SPLITS the ` +
            'table in every markdown renderer. Remove it.'
        );
        i = j;
        continue;
      }
      break; // end of the table
    }
    break; // end of the table
  }
  return { rows, problems, parsedRows };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

/**
 * Only when run directly. This module is imported as a library by
 * `close-review-row.mjs`, and an unguarded CLI block ran on import too — printing
 * the usage banner into that script's output on every invocation, which reads as
 * a warning and is not one.
 */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (!isMain) {
  // Imported for `buildRow` / `splitRow` / `checkTable`; nothing to do.
} else {
  const argv = process.argv.slice(2);
  const rowIndex = argv.indexOf('--row');

  if (rowIndex !== -1) {
    const payload = argv[rowIndex + 1];
    if (!payload) {
      console.error('review-row: --row needs a JSON payload');
      process.exit(2);
    }
    try {
      process.stdout.write(`${buildRow(JSON.parse(payload))}\n`);
    } catch (err) {
      console.error(`review-row: ${err && err.message}`);
      process.exit(1);
    }
  } else if (argv.includes('--check')) {
    if (!existsSync(REVIEW)) {
      console.error(`review-row: ${REVIEW} not found`);
      process.exit(2);
    }
    const { rows, problems, parsedRows } = checkTable(readFileSync(REVIEW, 'utf8'));
    if (problems.length) {
      for (const p of problems) console.error(p);
      console.error(`\nreview-row: ${problems.length} problem(s) across ${rows} rows.`);
      process.exit(1);
    }
    console.log(`review-row: ${rows} plan rows, all ${COLUMNS.length} columns.`);

    // **The histograms, printed on every run.**
    //
    // §8 of `review.md` states these numbers in prose, and they were wrong three
    // times in a row — 131 when the table held 170, then 179, then 193 when it
    // held 199. Not because anyone miscounted: because each audit adds rows, and
    // nothing recomputed a number that only a human retyped. This check already
    // parsed every row, so the counts were one map away; printing them makes the
    // prose number *checkable* rather than trusted, which is the only version of
    // a hand-maintained count worth having.
    const statuses = new Map();
    const priorities = new Map();
    for (const cells of parsedRows) {
      const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
      // Strip emphasis so `**P0**` and `P0` are one bucket rather than two.
      count(statuses, cells[1].replaceAll('*', '').trim());
      count(priorities, cells[3].replaceAll('*', '').trim());
    }
    const tally = (map) =>
      [...map.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([k, n]) => `${k} ${n}`)
        .join(', ');
    // `parsedRows.length`, not `rows.length`: `rows` is the *count* `checkTable`
    // reports, and reading `.length` off a number prints `undefined`. They agree
    // today, so a wrong total would print `undefined` here rather than a wrong
    // number — which is why it is worth deriving the total from the array the
    // histograms were actually built from.
    console.log(`  by status   (${parsedRows.length}): ${tally(statuses)}`);
    console.log(`  by priority (${parsedRows.length}): ${tally(priorities)}`);
    console.log('  §8 quotes these — if they differ, the prose is stale, not the table.');
  } else {
    console.log('usage: node scripts/review-row.mjs --check | --row \'{"id":...}\'');
    console.log(`columns: ${COLUMNS.join(', ')}`);
  }
}
