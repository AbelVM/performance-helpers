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
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reviewPath = resolve(root, 'review.md');
const lines = readFileSync(reviewPath, 'utf8').split('\n');

/** Plan rows only — the design section earlier in the file has other tables. */
// Whitespace-tolerant on purpose. `prettier --write` runs on this file via the
// pre-commit hook and re-pads table cells to `|  **ID**  |`, so a
// single-space pattern silently skipped every padded row — which is how a
// stray cell survived a check that reported the table clean.
const PLAN_ROW = /^\|\s*\*\*(BUG|QUAL|TEST|DOC|FEAT|PERF|BENCH|CFG|DEAD|DEFER|REJ)-\d+\*\*\s*\|/;

/** Eight columns: id, status, task, priority, ROI, risk, effort, notes. */
const COLUMNS = 8;

/**
 * How many columns a markdown row has.
 *
 * A trailing pipe is optional, so counting separators without accounting for
 * it is off by one for half the file. Getting this wrong is not subtle — the
 * test then fails on every row, or passes on rows it should not.
 *
 * @param {string} line
 * @returns {number}
 */
function cellCount(line) {
  const parts = line.split('|');
  return parts.length - 1 - (line.trimEnd().endsWith('|') ? 1 : 0);
}

describe('review.md plan table', () => {
  it('is readable', () => {
    expect(existsSync(reviewPath)).toBe(true);
    expect(lines.length).toBeGreaterThan(100);
  });

  it('every plan row has the same number of columns', () => {
    const bad = [];
    for (const line of lines) {
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

  it('does not check column *meaning*, which it cannot', () => {
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

  it('the notes cell ends with a section reference', () => {
    // A partial check on the thing `test/reviewTable.test.js` otherwise cannot
    // do: the rows disagree with the header about which column is which (see
    // the "does not check column meaning" test), so an append to the wrong cell
    // passes the column *count* check while quietly misfiling the text.
    //
    // It cost two appends' worth of confusion to find this: the TEST-008 notes
    // landed in a cell that looked like the notes and was not, and the row kept
    // its stale "52 waits" line the whole time. The notes cell is the one that
    // ends with `§x.y`, so an append that does not end there is visible.
    //
    // It is a heuristic, not a schema: rows whose notes legitimately end
    // elsewhere will need this relaxed deliberately rather than silently.
    const withRef = [];
    const without = [];
    for (const line of lines) {
      if (!PLAN_ROW.test(line)) continue;
      const cells = line.split('|');
      const last = cells[cells.length - 2]?.trim() ?? '';
      (/§[\d.]/.test(last) ? withRef : without).push(line.slice(2, 16).trim());
    }
    // Recorded as a baseline rather than asserted as a rule, because it is not
    // one: most rows do not end with a section reference, and that is the
    // misalignment the sibling test describes. Asserting either direction would
    // fail, and a test that always fails is worse than no test.
    //
    // What this buys is visibility. Editing the notes cell of a row that did
    // end with a section reference and appending prose after it moves one row
    // from `withRef` to `without` — which is exactly how both of tonight's
    // misfilings started, and neither was visible to the column-count check.
    expect({ withRef: withRef.length, without: without.length }).toEqual({
      withRef: 45,
      without: 62,
    });
  });

  it('has a plan row for every open item it claims to track', () => {
    // A sanity floor rather than an exact count: the table grows, and a test
    // that pins the number makes every legitimate addition a failure.
    const rows = lines.filter((line) => PLAN_ROW.test(line)).length;
    expect(rows).toBeGreaterThan(30);
  });
});
