import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * GATE-001: a comment-only `catch` must justify itself.
 *
 * `QUAL-006` claims that listener errors are swallowed deliberately and that this
 * "cannot regrow silently". That claim was structurally false, because ESLint's
 * `no-empty` ignores a block whose body is a comment — which is every one of them.
 * So the only way to know whether it held was to read 21 files.
 *
 * Parsed with the TypeScript parser rather than a regex, because a regex over
 * JavaScript is a regex over every way a comment can be written: **273 `catch`
 * clauses, 72 with no statement at all**, across 21 files. A regex finds 25 of
 * them, because it cannot see a block comment spanning a line break.
 */

/**
 * A comment that is a dismissal rather than a justification.
 *
 * Structural, not a list of words: a swallowing verb, and no second clause. The
 * clause test is what keeps the five legitimate ones out — `ignore formatter
 * errors **and fall back to** original payload`, `swallow **to avoid** throwing
 * from logging`, `swallow undo errors **— nothing more we can do**` all say what
 * they protect, and a keyword list guessed at that would have had to be
 * re-tuned every time somebody wrote a different correct sentence.
 *
 * Measured against `src/`: 44 sites, 16 distinct texts, no false positives.
 */
const DISMISSAL_VERB =
  /^(?:\/\*|\/\/)?\s*(?:ignore[ds]?|swallow(?:s|ed|ing)?|skip(?:s|ped|ping)?|noop|no-op|drop(?:s|ped)?|discard(?:s|ed)?)\b/i;

/** A conjunction, a dash or a semicolon — anything that starts a second clause. */
const CLAUSE = /[—–,;]|\b(?:and|then|to|so|because|that|which|otherwise|instead)\b/i;

/**
 * @param {string} text
 * @returns {boolean}
 */
function isDismissal(text) {
  if (!DISMISSAL_VERB.test(text)) return false;
  return !CLAUSE.test(text.replace(DISMISSAL_VERB, ''));
}

/**
 * The exact dismissals in `src/`, each with the judgement that permits it **and
 * how many sites may use it**.
 *
 * The count is the part that makes this a gate. Keyed by text alone, the
 * allowlist accepts a *new site* of an existing dismissal — mutation-checked, and
 * a newly added `/* ignore *\/` did not fail the gate. So each entry carries a
 * ceiling, and adding a twentieth `/* ignore *\/` is a diff to this file rather
 * than a free pass. The ceiling is the number of sites that exist today.
 *
 * The 26 sites behind the first two entries still carry no information
 * whatsoever, and that remains a real gap: fixing them means reading 26 call
 * sites and writing 26 true reasons, recorded as follow-up in `review.md`'s
 * GATE-001. What ships here is the property that a *new* dismissal — new text or
 * one more site — has to be argued for in a file a reviewer can read.
 */
const ALLOWED = new Map([
  // [text, [maxSites, why]]
  ['/* ignore */', [19, 'Carries no information at all. Follow-up work; see review.md.']],
  ['/* swallow */', [7, 'Same judgement as `/* ignore */`, and the same follow-up.']],
  [
    '/* ignore console failures */',
    [1, 'Inside a logging call, whose own contract is that logging must not throw.'],
  ],
  [
    '/* ignore finalizer errors */',
    [1, 'A finalizer runs during disposal, where there is no caller left to report to.'],
  ],
  [
    '/* ignore formatting failures */',
    [1, 'Formatting is a presentation concern; a failure falls back to the raw value.'],
  ],
  [
    '/* ignore cache update errors */',
    [1, 'Cache-side bookkeeping must not fail the operation of the caller.'],
  ],
  ['/* ignore bookkeeping errors */', [1, 'Counters cannot fail in a way a caller could act on.']],
  [
    '/* ignore mapping failures */',
    [1, 'The mapping is a per-item optimisation; the item itself already succeeded.'],
  ],
  ['// ignore logger failures', [1, 'Inside a logger call; see `ignore console failures`.']],
  [
    '// ignore registration failures',
    [1, 'Registration is best-effort; the helper is usable whether or not it lands.'],
  ],
  [
    '// ignore cleanup failures',
    [2, 'Cleanup is already running under a teardown that cannot report anything.'],
  ],
  [
    '/* swallow cache errors */',
    [1, 'A user eviction hook, which the guide and getStats() both document as never propagating.'],
  ],
  ['/* swallow logging failures */', [1, 'Inside a logging call; see `ignore console failures`.']],
  [
    '/* swallow user callback errors */',
    [2, "A user callback throwing is the caller's own error and is not re-wrapped."],
  ],
  ['// swallow subscriber errors', [2, 'A subscriber error must not break the emitter.']],
  ['// swallow', [2, 'Same judgement as `/* swallow */`.']],
]);

/**
 * Every `.js` file under a directory, as paths relative to the repository root.
 *
 * @param {string} dir
 * @param {string} root
 * @returns {string[]}
 */
function jsFiles(dir, root) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full, root));
    else if (entry.endsWith('.js')) out.push(path.relative(root, full));
  }
  return out;
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const files = jsFiles(path.join(ROOT, 'src'), ROOT);

const statementless = [];
const trulyEmpty = [];
const unaccounted = [];
/** How many sites use each allowlisted text. */
const allowedUse = new Map();

for (const file of files) {
  const source = readFileSync(path.join(ROOT, file), 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
  const visit = (node) => {
    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      const text = source
        .slice(node.block.getStart(sf) + 1, node.block.end - 1)
        .replace(/\s+/g, ' ')
        .trim();
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      statementless.push({ file, line, text });
      if (text === '') trulyEmpty.push(`${file}:${line}`);
      else if (isDismissal(text) && !ALLOWED.has(text)) {
        unaccounted.push(`${file}:${line} ${JSON.stringify(text)}`);
      } else if (ALLOWED.has(text)) {
        allowedUse.set(text, (allowedUse.get(text) ?? 0) + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

describe('every swallowed error in src/ says why it is safe (GATE-001)', () => {
  it('parses the whole of src/, so the counts below are real', () => {
    // Without this the rest of the file could pass by finding nothing at all,
    // which is the failure mode this project has now hit three times: a guard
    // that matches nothing is not a guard.
    expect(files.length).toBeGreaterThan(40);
    expect(statementless.length).toBeGreaterThan(50);
  });

  it('has no catch clause with an entirely empty body', () => {
    // The subset ESLint does catch, and which is currently empty. Cheap, and it
    // stays cheap: no statement and no comment is a bug with no excuse, so this
    // one needs no allowlist.
    expect(
      trulyEmpty,
      'a catch with no statement and no comment swallows silently. Add a comment ' +
        'saying why, or handle the error.'
    ).toEqual([]);
  });

  it('has no catch clause whose comment is a dismissal with no reason', () => {
    expect(
      unaccounted,
      'a comment-only catch must say why swallowing is safe — what it protects, or\n' +
        'what state makes it safe. "ignore" says neither. Either write the reason,\n' +
        'or add the exact text to ALLOWED in this file with the judgement, so that\n' +
        'the next reader can disagree with it.'
    ).toEqual([]);
  });

  it('keeps every allowlisted dismissal justified, in use, and within its ceiling', () => {
    // The ceiling is the assertion that makes this a gate. Keyed by text alone,
    // the allowlist accepted a *new site* of an existing dismissal — verified by
    // mutation, a freshly added `/* ignore */` passed. So each entry records how
    // many sites may use it, and a new one is a diff to this file.
    for (const [text, [maxSites, why]] of ALLOWED) {
      expect(why.length, `${JSON.stringify(text)} has an empty justification`).toBeGreaterThan(20);
      const used = allowedUse.get(text) ?? 0;
      expect(used, `${JSON.stringify(text)} matches nothing — remove it`).toBeGreaterThan(0);
      expect(
        used,
        `${JSON.stringify(text)} is used at ${used} sites, over its ceiling of ${maxSites}. ` +
          'Either the new sites deserve a real reason — in which case fix the ' +
          'comment rather than the ceiling — or raise the ceiling here, in a diff, ' +
          'with the judgement for the extra sites.'
      ).toBeLessThanOrEqual(maxSites);
    }
  });

  it('classifies a dismissal and a justification the same way each run', () => {
    // The rule is prose-shaped, so it gets a characterisation: the six comments
    // below are the ones it has to get right, split three ways. If a refactor
    // changes the verdict on any of them, this says which way and why.
    const dismissals = ['/* ignore */', '// swallow', '/* ignore cache update errors */'];
    const justifications = [
      '/* a failing error handler must never break the cache */',
      '// ignore formatter errors and fall back to original payload',
      '// swallow undo errors — nothing more we can do',
    ];
    for (const text of dismissals) expect(isDismissal(text), text).toBe(true);
    for (const text of justifications) expect(isDismissal(text), text).toBe(false);
  });
});
