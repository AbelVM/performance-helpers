import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `review.md` is a markdown table with nine columns, and it is edited by
 * script.
 *
 * That combination has broken it three times in one session, and every time it
 * broke *silently*: a literal `|` inside a cell splits it in two, and the row
 * still renders as a row — it just quietly loses a column, and the text around
 * the stray pipe reads as though nothing happened. Nothing in the file says it
 * is wrong, and no test noticed until the table was checked by eye.
 *
 * The failures were not hypothetical. `BUG-024`, `QUAL-007`, `QUAL-009` and
 * `CFG-002` all had a notes cell split across several columns, and two more
 * rows were damaged and repaired during the edits that caused them.
 *
 * A markdown table also has no row count, so there is no other way to notice:
 * a row with the wrong number of pipes is still valid markdown.
 *
 * ## The file this checks is not in the repository
 *
 * `review.md` is a working document and is listed in `.gitignore`, so a fresh
 * clone does not have one. This test used to `readFileSync` it at module scope,
 * which meant CI — which runs the whole suite through `test:coverage` — failed
 * on a file that was never going to be there. A test that cannot pass in its own
 * CI is worse than no test: it is a red build that gets muted, and muting it
 * teaches the team to ignore the signal rather than the bug.
 *
 * So the read is guarded and the suite skips when the file is absent. The check
 * still runs everywhere it is useful — a contributor working on `review.md` has
 * one — and there is a test below asserting the skip is for the stated reason
 * rather than the file having quietly moved.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reviewPath = resolve(root, 'review.md');
/** Whether the working copy has a `review.md` to check. False on a clean clone. */
const reviewPresent = existsSync(reviewPath);
const lines = reviewPresent ? readFileSync(reviewPath, 'utf8').split('\n') : [];

/** Plan rows only — the design section earlier in the file has other tables. */
/**
 * The header of the plan table, and the only reliable way to find it.
 *
 * Matching rows by their ID shape is what this used to do, and it matched
 * nothing at all: the pattern required the ID to be bolded (`|  **BUG-024**  |`)
 * on the strength of a comment saying prettier produces that, and no row is
 * bolded. `expect(rows).toBeGreaterThan(30)` then failed against **0** rows, so
 * every other check in this file — the column-count one included — had been
 * passing vacuously. A guard that matches nothing is not a guard, and the way to
 * find a table is by its header, not by guessing at its contents.
 *
 * Whitespace-tolerant on the same grounds as before: `prettier --write` re-pads
 * cells, so a single-space pattern would skip every padded row.
 */
const PLAN_HEADER = /^\|\s*ID\s*\|/;

/** One plan row: an `XXX-NNN` id in the first cell, bolded or not. */
const PLAN_ROW = /^\|\s*\**[A-Z][A-Z0-9]*-\d+\**\s*\|/;

/**
 * The plan table's own lines, from its header to the first line that is not a
 * row. Scoping it this way rather than scanning the whole file is what keeps the
 * earlier design tables out of the column-count check — they have a different
 * column count and would otherwise read as 8 malformed rows.
 *
 * @param {string[]} allLines
 * @returns {string[]}
 */
function planTable(allLines) {
  const start = allLines.findIndex((l) => PLAN_HEADER.test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 2; i < allLines.length; i += 1) {
    // The separator row is index `start + 1`; a blank line or a heading ends the
    // table, and a stray one is a real hazard this table has already hit.
    if (!allLines[i].trimStart().startsWith('|')) break;
    out.push(allLines[i]);
  }
  return out;
}

/** Eight columns: id, status, task, priority, ROI, risk, effort, notes. */
const COLUMNS = 8;

/** Unescaped pipes are the cell delimiters; escaped ones are content. */
const UNESCAPED_PIPE = /(?<!\\)\|/;

/**
 * How many columns a markdown row has, **and whether it is in canonical form**.
 *
 * Three ways to get this wrong, and this file has now done all three.
 *
 * An **escaped** `\|` is content, not a separator — it is how a cell holds a
 * literal pipe. Splitting on every `|` counted those too, so five correctly
 * written rows were reported as having 9 and 10 columns. That is the same failure
 * as the one this file exists to catch, pointing the other way: the guard flagged
 * good rows, which is how a guard earns the mute button.
 * `scripts/review-row.mjs` has had the negative-lookbehind split all along; the
 * two are kept in step deliberately rather than by coincidence.
 *
 * A trailing pipe was, until now, treated as **optional** — the reasoning being
 * that markdown permits its absence, so counting separators without accounting for
 * it would be off by one for half the file. That is true of markdown and false of
 * *this table*, and the difference is the whole point:
 * `scripts/review-row.mjs`'s `splitRow` is `.split(UNESCAPED_PIPE).slice(1, -1)`,
 * so it **requires** both a leading and a trailing pipe and reports one fewer cell
 * without the trailing one.
 *
 * **The two components disagreed, and the guard was the lenient one — which is the
 * worst way round.** Found by doing it: a row was filed with eight separators and no
 * closing pipe, `cellCount` called it a well-formed 8 columns, the whole table check
 * passed 8/8, and `close-review-row` then refused to edit it with *"RES-039 has 7
 * cells, expected 8"*. A guard that accepts rows the writer rejects is not a weaker
 * guard, it is a guard pointed the other way. All 208 plan rows carry the trailing
 * pipe — every one is script-built, so the leniency protected nothing and cost the
 * check its last line of defence.
 *
 * @param {string} line
 * @returns {number}
 */
function cellCount(line) {
  return line.split(UNESCAPED_PIPE).length - 1 - 1;
}

describe('review.md availability', () => {
  // Unconditional, and the reason this file is not simply deleted.
  it('is gitignored, so a clean clone has no review.md to check', () => {
    const gitignore = readFileSync(resolve(root, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^\s*review\.md\s*$/m);
  });

  it('the plan-table check skips rather than failing when the file is absent', () => {
    // If `review.md` is missing, the checks below are skipped — not failed.
    // Asserted explicitly so that "the suite is green" cannot mean "the guard
    // stopped applying and nobody noticed", which is how this broke in the
    // first place.
    if (reviewPresent) {
      expect(lines.length).toBeGreaterThan(100);
    } else {
      expect(lines).toEqual([]);
    }
  });
});

describe.skipIf(!reviewPresent)('review.md plan table', () => {
  const table = planTable(lines);

  it('is readable', () => {
    expect(existsSync(reviewPath)).toBe(true);
    expect(lines.length).toBeGreaterThan(100);
  });

  it('has a header the validators can find', () => {
    // The one assertion whose absence makes every other check in this file
    // meaningless. `scripts/review-row.mjs` locates the table the same way, and
    // when the header was `| Task ID |` it reported "0 rows, no problem found"
    // while the table held 131 of them — a clean report describing a file it had
    // not read.
    expect(PLAN_HEADER.test(lines.find((l) => l.includes('| ID |')) ?? '')).toBe(true);
  });

  it('every plan row has the same number of columns', () => {
    const bad = [];
    for (const line of table) {
      if (!PLAN_ROW.test(line)) continue;
      const count = cellCount(line);
      if (count !== COLUMNS) {
        bad.push(`${line.slice(2, 16).trim()} -> ${count} columns`);
      }
    }
    expect(
      bad,
      'a literal `|` inside a cell splits it; the row still renders, so nothing ' +
        'else will catch this. Escape it as `\\|` or use another separator.'
    ).toEqual([]);
  });

  it('every plan row is in canonical form: leading and trailing pipe', () => {
    // A **separate** assertion from the column count above, and it has to be
    // separate. The count alone cannot express "8 columns is right *and* the row
    // is written the way the writer writes them", so a row missing its closing pipe
    // was counted as correct and then rejected by `scripts/review-row.mjs`.
    //
    // Both ends, because `splitRow` is `.slice(1, -1)`: it drops the field before
    // the leading pipe and the field after the trailing one. A row missing either
    // loses a cell there.
    const bad = [];
    for (const line of table) {
      if (!PLAN_ROW.test(line)) continue;
      const trailing = line.trimEnd().endsWith('|');
      if (!trailing) bad.push(`${line.slice(2, 16).trim()} -> no trailing pipe`);
    }
    expect(
      [...new Set(bad)],
      'a plan row lost its trailing `|`. `scripts/review-row.mjs` splits rows with ' +
        '`.slice(1, -1)`, so it reads that row as one column short and refuses to ' +
        'edit it — while the column-count check called it well formed.'
    ).toEqual([]);
  });

  it('does not check column *meaning*, or a section reference, which it cannot', () => {
    // Both omissions are deliberate, and both were arrived at by writing the
    // check first and watching it fail.
    //
    // **A section-reference check cannot be a count.** The obvious form —
    // "assert that N rows end their notes with a section reference" — describes
    // a file that is not in the repository, so in CI it asserts nothing (the
    // suite is skipped) and locally it has to be retuned in the same commit as
    // every row that gets closed. A test whose expected value is "whatever the
    // untracked file currently says" is not a test.
    //
    // **It cannot be a property either.** The stronger form — "every row's notes
    // cite a section" — is false: 60 of the 107 plan rows do not, and they are
    // not malformed, they are just not written that way. Asserting it would
    // require inventing references to make a heuristic pass, which is worse
    // than having no check.
    //
    // So the real remaining hazard is the one the column-count test below does
    // catch: an append landing in the wrong cell. That is documented in
    // `guides/metaGuide.md` and it is a human-judgement problem, not something
    // a script over an untracked markdown file can settle.

    // Recorded here because it is a real and unresolved problem, and because a
    // future reader may reasonably assume this file validates the table's
    // contents. It does not, and it cannot: the rows disagree with the header
    // about what the fourth column holds.
    //
    // 64 of 100 plan rows put prose where the header says `Priority`.
    // `DEFER-004` follows the header (`**P3**`); `BUG-001` and `TEST-001` put a
    // shipped-summary or a section reference there instead. Fixing that means
    // deciding, per row, which of two prose cells is the priority and which is
    // the notes — and a wrong call silently relocates content, which is worse
    // than the ambiguity. It needs a human pass over the table, not a script.
    expect(true).toBe(true);
  });

  it('has no two rows with the same identifier', () => {
    // A duplicate is invisible in a rendered table — markdown shows two
    // perfectly well-formed rows — and it is how a row ends up *shadowing* a real
    // open item, which is worse than either being absent.
    //
    // Found by doing it: a finding was filed as `RT-022`, already in use by an
    // unrelated open row about `SharedArrayBuffer` transfer lists, and
    // `scripts/review-row.mjs --check` reported *clean*. The validator checked
    // columns and the header; a duplicate is neither. The script now checks it,
    // and this asserts the table the script checks.
    const seen = new Map();
    const dupes = [];
    for (const line of table) {
      if (!PLAN_ROW.test(line)) continue;
      const id = line.slice(2, line.indexOf(' |', 2)).trim();
      if (!seen.has(id)) seen.set(id, line);
      else dupes.push(id);
    }
    expect(
      [...new Set(dupes)],
      'two rows share an identifier, so one shadows the other and neither can be ' +
        'tracked. Re-file under a fresh ID, or close the row you duplicated.'
    ).toEqual([]);
  });

  it('has a plan row for every open item it claims to track', () => {
    // A sanity floor rather than an exact count: the table grows, and a test
    // that pins the number makes every legitimate addition a failure. It is a
    // floor and not zero precisely so that a future change to the row pattern
    // fails here rather than quietly emptying every check above it.
    const rows = table.filter((line) => PLAN_ROW.test(line)).length;
    expect(rows).toBeGreaterThan(30);
  });
});
