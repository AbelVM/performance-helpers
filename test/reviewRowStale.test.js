/**
 * The plan-table validator, on the failure it could not see.
 *
 * `scripts/review-row.mjs` catches a bare `|` splitting a cell, a note written
 * into the wrong column, a blank line splitting the table, and a duplicate ID.
 * All four are *structural*. A row whose status says open while its note says the
 * work is done is structurally perfect, so the validator reported it as healthy
 * for four commits.
 *
 * `RT-005` is how that happened. The note was written and the status cell was
 * left untouched, so the table asserted two contradictory things and nothing
 * objected. `AGENTS.md` already names the consequence — "a stale row is worse
 * than a missing one: it sends someone to build something twice" — and the fix
 * was `scripts/close-review-row.mjs`, a tool that existed to make exactly this
 * edit correctly and had not been used.
 *
 * The assertions here are on a synthetic table, never on `review.md`. `AGENTS.md`
 * is explicit that a test depending on an untracked file passes locally and has
 * nothing to fail against in CI, and `review.md` is gitignored — so a test that
 * asserted the real table would assert nothing in CI and would break the moment
 * someone closed a row.
 */
import { describe, it, expect } from 'vitest';
import { checkTable, claimsCompletion, OPEN_MARKER, COLUMNS } from '../scripts/review-row.mjs';

const HEADER = `| ${COLUMNS.join(' | ')} |`;
const SEPARATOR = `| ${COLUMNS.map(() => '---').join(' | ')} |`;

/**
 * @param {Object} spec
 * @param {string} spec.id
 * @param {string} spec.status
 * @param {string} spec.note
 * @returns {string}
 */
const row = ({ id, status, note }) =>
  `| ${id} | ${status} | Do the thing | **P1** | High | Low | S | ${note} |`;

describe('a stale status is reported', () => {
  it('flags a row marked open whose note claims the work is done', () => {
    // The RT-005 shape, exactly: right column count, coherent prose, wrong
    // marker. Before the check this reported zero problems.
    const text = [
      HEADER,
      SEPARATOR,
      row({ id: 'RT-005', status: OPEN_MARKER, note: ' Done, reproduced first: 0 of 1 messages.' }),
    ].join('\n');

    const { problems } = checkTable(text);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('RT-005');
    expect(problems[0]).toContain('marked open but its note claims the work is done');
    // The message has to say what to do, or it is just a complaint.
    expect(problems[0]).toContain('close-review-row.mjs');
  });

  it('says nothing once the status agrees with the note', () => {
    const text = [
      HEADER,
      SEPARATOR,
      row({ id: 'RT-005', status: '✅', note: ' Done, reproduced first: 0 of 1 messages.' }),
    ].join('\n');

    expect(checkTable(text).problems).toEqual([]);
  });

  it('says nothing for an open row whose note does not claim completion', () => {
    // The common case, and the one that decides whether the check is usable: a
    // gate that fired on ordinary open rows would be turned off within a day.
    const text = [
      HEADER,
      SEPARATOR,
      row({ id: 'RES-001', status: OPEN_MARKER, note: 'Not started. Depends on RES-002.' }),
    ].join('\n');

    expect(checkTable(text).problems).toEqual([]);
  });

  it('does not fire on a row whose status is not the open marker', () => {
    // `🟡` (partial) legitimately carries both a claim and a remainder, so only
    // the open marker is checked.
    const text = [
      HEADER,
      SEPARATOR,
      row({
        id: 'GATE-001',
        status: '🟡',
        note: ' Done, the first half. The second half is open.',
      }),
    ].join('\n');

    expect(checkTable(text).problems).toEqual([]);
  });

  it('does not misread a row whose note merely contains the word', () => {
    // The false-positive guard. `done` mid-sentence, capitalised differently, or
    // glued to other characters is not a completion claim, and treating it as one
    // is how a stop-list becomes a hole.
    const notes = [
      'Not started: the cache is done warming up before the scan.',
      'Waiting on RES-002. Done-ness is not tracked here.',
      'The Done button is missing from the adapter.',
    ];
    for (const note of notes) {
      const text = [HEADER, SEPARATOR, row({ id: 'X-001', status: OPEN_MARKER, note })].join('\n');
      expect(checkTable(text).problems, `false positive on: ${note}`).toEqual([]);
    }
  });

  it('stays quiet on a row whose cells are broken, rather than reading nonsense', () => {
    // With the wrong cell count, `cells[7]` is not the note. Reporting a stale
    // status off a mis-parsed row would be a second, misleading complaint about
    // the same line.
    const broken = `| X-001 | ${OPEN_MARKER} | Missing cells`;
    const text = [HEADER, SEPARATOR, broken].join('\n');

    const { problems } = checkTable(text);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('cells');
    expect(problems[0]).not.toContain('marked open');
  });
});

describe('claimsCompletion', () => {
  it('matches the phrase this document uses and nothing looser', () => {
    expect(claimsCompletion('Done, reproduced first.')).toBe(true);
    expect(claimsCompletion(' Done.')).toBe(true);
    expect(claimsCompletion('Partly stale. Done, then reverted.')).toBe(true);
    expect(claimsCompletion('Not started.')).toBe(false);
    expect(claimsCompletion('Done')).toBe(false);
    expect(claimsCompletion('undone')).toBe(false);
    expect(claimsCompletion('')).toBe(false);
    expect(claimsCompletion(undefined)).toBe(false);
  });
});
