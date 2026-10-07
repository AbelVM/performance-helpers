/**
 * `docs:claims` — the guide/documentation drift guard.
 *
 * ## Why this exists
 *
 * Two defects in this repository shipped undetected, and neither was caught by
 * `docs:drift`:
 *
 * - `guides/powerThrottle.md` documented `refillInterval` as a real option with
 *   a default of `1000`. The option had been removed in 9a1d9d5 *precisely
 *   because it was inert*, and `types/helpers/powerThrottle.d.ts` correctly
 *   omitted it. Only the hand-written guide still carried it. So the one surface
 *   a user is most likely to read was the one surface that was wrong, and a
 *   caller who set it got silence in return and a limiter that happened to
 *   behave correctly by accident.
 * - `llms.txt` claims to be derived from the guides' own opening sentences "so
 *   the two can only disagree if the guide changes", and had already disagreed:
 *   both it and `guides/metrics.md` asserted that *every* helper reports through
 *   its own `stats()`, which was false about `PowerPool`, and `metrics.md`
 *   contradicted itself seven lines later. Nothing read `llms.txt` at all —
 *   no test, no script, no workflow — so it drifted silently for as long as it
 *   existed.
 *
 * `docsCodeAgreement.test.js` and `docsLinks.test.js` exist and neither catches
 * either, because both check *code* referenced from the docs. These are the
 * reverse direction: a doc asserting something about the code.
 *
 * ## What it checks
 *
 * 1. **Every constructor option named in a guide exists in the source.** Read from
 *    the generated `types/helpers/*.d.ts` rather than the source, because a
 *    hand-rolled parse of a `constructor(...)` signature misses defaults,
 *    destructuring and positional classes — and because `types/` is already the
 *    thing that is guaranteed regenerated.
 * 2. **Every guide linked from `llms.txt` exists**, and its summary is still the
 *    guide's own opening sentence.
 *
 * ## What it deliberately does not check
 *
 * Option *defaults*. `guides/powerThrottle.md` claimed `refillInterval` defaulted
 * to `1000`, and a default is not recorded in the published `.d.ts` at all, so
 * this cannot see one. The name is the detectable part and the name was the part
 * that misled. A default-value guard would need to parse JSDoc `@property`
 * tags, which is a different and much more fragile check.
 *
 * ## Why this is a separate script and not a test
 *
 * Per `AGENTS.md`, the gate is `scripts/verify.mjs` and it is the only list of
 * checks — a copy once lived in the CI workflow and drifted until CI was running
 * neither `test:types` nor `check:bundle`. So this runs as `npm run
 * docs:claims` and is invoked from `STEPS`, not added to `.github/workflows`.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const GUIDES_DIR = path.join(ROOT, 'guides');
const TYPES_DIR = path.join(ROOT, 'types', 'helpers');

/** @type {string[]} */
/**
 * A code fragment spliced into a prose summary.
 *
 * Keyed on shape rather than on a bare keyword. A splice always carries a brace,
 * a star, a quoted path or `from` — never just the word.
 */
const CODE_FRAGMENT = /\b(?:import|export)\s*(?:[{'"]|[*]|\w+\s+from\b)|require\s*\(|function\s*\(/;

const problems = [];
/** @type {string[]} */
const notes = [];

// ── 1. guide option names must exist in the published declarations ──────────

/**
 * Collect the option names a constructor accepts, from the generated
 * declaration. Reads `options?: SomeTypedef` and expands that typedef's
 * `@property` names out of `jsdoc-types.d.ts`.
 *
 * @param {string} src - contents of one `types/helpers/*.d.ts`
 * @param {string} shared - contents of `types/helpers/jsdoc-types.d.ts`
 * @returns {Set<string>} option names
 */
function optionNamesFromDeclaration(src, shared, unresolved) {
  const names = new Set();
  // The typedef is read from the **generated** declaration, and the generated
  // form is `export type FooOptions = { field?: string | undefined; ... }` — not
  // the `@typedef {Object} Foo` JSDoc it was written as. The first version of
  // this function matched the JSDoc spelling, found zero matches, and therefore
  // reported "no options typedef found" for all 10 guides it was supposed to
  // check — including `powerThrottle.md`, the guide that motivated this script.
  // A guard that checks nothing while printing `ok` is worse than no guard, so
  // the parse targets the emitted shape and an unresolved typedef is an error
  // rather than a note.
  //
  // Both `shared` (jsdoc-types.d.ts) and `src` (the helper's own declaration) are
  // searched, because a typedef is not always in `jsdoc-types.js`: `PowerGCRAOptions`
  // and `HubOptions` are declared in their own files and exported from there.
  // Searching only the shared file silently skipped those two guides.
  const pool = `${shared}\n${src}`;
  // The leading `\??` matters: `PowerRealtimeHub`'s constructor is
  // `constructor(options: HubOptions)` — **required**, not optional — and
  // matching only `\?:` resolved no options for it at all, so its table was
  // unchecked while the report said nothing was wrong with it. A required
  // options parameter lists exactly the same accepted names as an optional one.
  //
  // Two spellings also occur, and missing either silently skips a guide: a bare
  // name (`options?: PowerThrottleOptions`) and an inline import
  // (`options?: import("./jsdoc-types.js").PowerBatchOptions`).
  // The second is what `powerBatch` and `powerLatch` emit, and they went
  // unchecked until this matched it.
  for (const m of src.matchAll(
    /\??: (?:import\("[^"]*"\)\.)?([A-Za-z_$][\w$]*(?:Options|Config))\b/g
  )) {
    const typedefName = m[1];
    const block = pool.match(new RegExp(`^export type ${typedefName} = \\{([\\s\\S]*?)^\\};`, 'm'));
    if (!block) {
      unresolved.push(typedefName);
      continue;
    }
    // `    capacity?: number | undefined;`
    for (const p of block[1].matchAll(/^ {4}([A-Za-z_$][\w$]*)\??:/gm)) {
      names.add(p[1]);
    }
  }
  return names;
}

const sharedTypes = existsSync(path.join(TYPES_DIR, 'jsdoc-types.d.ts'))
  ? readFileSync(path.join(TYPES_DIR, 'jsdoc-types.d.ts'), 'utf8')
  : '';

/**
 * Map a guide's backticked `option` cells to a declaration file, by matching the
 * helper name in the guide's own heading.
 *
 * @param {string} guideName
 * @returns {string|null}
 */
function declarationForGuide(guideName) {
  const candidates = readdirSync(TYPES_DIR).filter((f) => f.endsWith('.d.ts'));
  const cls = guideName.replace(/^(power|worker)/, (m) => m).replace(/\.md$/, '');
  const wanted = `class ${cls[0].toUpperCase()}${cls.slice(1)}`;
  for (const file of candidates) {
    const src = readFileSync(path.join(TYPES_DIR, file), 'utf8');
    if (src.includes(wanted)) return src;
  }
  return null;
}

/** Helpers whose guide documents a constructor options table. */
const GUIDES_WITH_OPTION_TABLES = readdirSync(GUIDES_DIR).filter((f) => f.endsWith('.md'));
/** Typedefs referenced by a constructor but not resolvable in the shared declarations. */
const unresolvedTypedefs = [];

for (const guide of GUIDES_WITH_OPTION_TABLES) {
  const guidePath = path.join(GUIDES_DIR, guide);
  const text = readFileSync(guidePath, 'utf8');
  const decl = declarationForGuide(guide.replace(/\.md$/, ''));
  if (!decl) continue;
  const known = optionNamesFromDeclaration(decl, sharedTypes, unresolvedTypedefs);

  let checked = 0;
  const unknown = new Set();

  // Only the **constructor options table** — a `## Constructor` heading
  // followed by a markdown table. Scanning every backticked first-column cell
  // across the whole guide picked up two other tables and produced four false
  // positives on the first run: `powerPool.md` and `powerScheduler.md` list a
  // leading *positional* argument (`workerSource`, `MessageChannel`) in the same
  // table as the options, and `powerSocketAdapter.md` has a constructor-argument
  // table of its own (`ws`, `stream`, `websocket`, `WebSocketStream`).
  //
  // Two shapes are legitimate and both are handled:
  //   - `options.size` — the nested form several guides use, stripped to `size`.
  //   - a leading positional (`level`, `workerSource`) — skipped, because it is a
  //     constructor parameter and not a field of the options typedef.
  // `\Z`, not `$`: this regex carries the `m` flag (it has to, for `^##+`), and
  // under `m` `$` matches at every line end — so `$` truncated the section to the
  // bare heading and the check silently compared nothing. eslint flags `\Z` as a
  // useless escape; it is not, and the alternative costs the whole check. Hence
  // the disable, which is the narrowest one that keeps the intent honest.
  // Locate the options table by its **header row**, wherever it sits, rather than
  // by looking for a `## Constructor` heading. The headings vary across the
  // guides — `## Constructor`, `## Options`, `### API` — and matching one name
  // left 16 guides silently unchecked, which is coverage the report claimed not
  // to have. Keying on the header is both more robust and the actual intent: a
  // table whose first column is `option` *is* an options table.
  //
  // This also removes the false positive that made the heading approach
  // necessary: `powerSocketAdapter.md` has a `## Constructor` heading followed by
  // a transport-detection table (`stream` / `websocket` / `ws` — how a socket is
  // recognised at runtime), which is not an options table at all.
  const tableRe = /^\|[^\n]*\|[^\n]*\n\|\s*-{2,}[^\n]*\n(?:\|[^\n]*\n)+/gm;
  let rows = null;
  for (const t of text.matchAll(tableRe)) {
    const cells = t[0]
      .split('\n')[0]
      .split('|')
      .map((c) => c.trim());
    if (/^`?options?`?$/i.test(cells[1] ?? '')) {
      rows = [...t[0].matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]);
      break;
    }
  }
  if (!rows || known.size === 0) {
    // The two causes are reported separately, and the reason is `c1af61b`.
    // `PowerRealtimeHub`'s constructor is `constructor(options: HubOptions)` -
    // **required**, not optional - and a parser matching only `?:` resolved no
    // options for it at all. That miss was reported here as this same benign
    // note, so a guide that was silently unchecked read exactly like a guide
    // that genuinely has no options. A reader must be able to tell them apart.
    // Only one thing is known for certain here, so only one thing is claimed.
    // `known` empty means this parser could not read an options type off the
    // declaration — which is true both for a class that takes no options
    // (`powerDefer`) and for one whose signature it does not recognise
    // (`PowerQueue`'s `constructor(initialCapacity?: number, options?: X)`). An
    // earlier version of this note asserted "takes no options object", which is
    // false for the second group; guessing the reason is what hid the
    // `PowerRealtimeHub` miss in the first place.
    notes.push(
      known.size > 0
        ? `${guide}: the helper declares ${known.size} option(s) but the guide has ` +
            'no options table - NOT CHECKED'
        : `${guide}: no options type resolvable from the declaration; option names ` +
            'NOT CHECKED (positional constructor, or a signature this parser does ' +
            'not recognise - it cannot tell which)'
    );
    continue;
  }
  // The first row after the header is the leading positional when the table
  // carries one; every subsequent row is an option.
  const skipFirst = /^\w+$/.test(rows[0] ?? '') && known.size > 0 && !known.has(rows[0]);
  const candidates = skipFirst ? rows.slice(1) : rows;

  for (const raw of candidates) {
    const option = raw.replace(/^options\./, '');
    if (
      ['option', 'options', 'input', 'kind', 'type', 'argument', 'name'].includes(
        option.toLowerCase()
      )
    ) {
      continue;
    }
    checked += 1;
    if (!known.has(option)) unknown.add(option);
  }

  if (unknown.size > 0) {
    problems.push(
      `${guide}: documents option(s) the published declaration does not have \u2014 ` +
        [...unknown].join(', ') +
        '. The generated types are right if the source is; a hand-written guide row is what drifts.'
    );
  } else if (checked > 0) {
    notes.push(`${guide}: ${checked} documented option name(s) all present`);
  }
}

// ── 2. llms.txt must not contain truncated or corrupted guide summaries ──────
//
// The header of `llms.txt` claims every line is "a title and that guide's own
// opening sentence … so the two can only disagree if the guide changes". That
// claim is **not** what the file does, and the mismatch was invisible because
// nothing read it. Ten of its 49 entries are genuine paraphrases — deliberate,
// and in several cases better than the guide's own first line.
//
// So this does not check verbatim agreement, because that would fail 10 correct
// entries and train people to ignore it. It checks the thing that was actually
// broken: **7 entries had prose sliced off mid-sentence and replaced with a code
// fragment**, e.g.
//
//   Counting barrier primitive. Resolves pending waiters when the internal
//   count reaches zero. import { PowerLatch } from '../src/helpers/powerLatch.js';
//
// An `import` statement appended to a summary is not a stylistic drift, it is a
// generation bug — and it was shipped, in a file whose entire purpose is to be
// read by a machine.

const llmsPath = path.join(ROOT, 'llms.txt');
if (existsSync(llmsPath)) {
  const llms = readFileSync(llmsPath, 'utf8');
  let checkedEntries = 0;
  const broken = [];

  for (const entry of llms.matchAll(/^- \[([^\]]+)\]\([^)]*\/guides\/([^)]+)\):\s*(.+)$/gm)) {
    const [, name, file, summary] = entry;
    checkedEntries += 1;
    if (!existsSync(path.join(GUIDES_DIR, file))) {
      broken.push(`[${name}] links to guides/${file}, which does not exist`);
      continue;
    }
    // A code fragment spliced into prose.
    //
    // Detection is by *shape*, not by keyword: a real splice carries a brace, a
    // star, a quoted path or the keyword `from`. Matching bare \bimport\b flagged
    // "helpers **import**ed by the library" and "**exports** documented here" as
    // corruption, which is how a guard teaches people to ignore it — an earlier
    // version of this line did exactly that. Matching `require` followed by any
    // word was worse, catching "rate limiters **require** configuration".
    if (CODE_FRAGMENT.test(summary)) {
      broken.push(
        `[${name}] summary contains a code fragment — the guide sentence was ` +
          `truncated mid-sentence and a code sample appended:\n        ${summary}`
      );
      continue;
    }
    // A summary that stops mid-sentence without an ellipsis. Prose legitimately
    // truncates in this file, but it truncates *with* `…`. The ellipsis is
    // stripped before this test, so it must not then be mistaken for a sentence
    // ending in a letter.
    if (!/…\s*$/.test(summary) && /[a-z,]$/.test(summary.trimEnd())) {
      broken.push(`[${name}] summary ends mid-sentence with no ellipsis:\n        ${summary}`);
    }
  }

  if (checkedEntries === 0) {
    problems.push('llms.txt: no guide entries parsed — the check is not looking at anything.');
  }
  if (broken.length > 0) {
    problems.push(
      `llms.txt: ${broken.length} of ${checkedEntries} entries are corrupted.\n` +
        broken.map((b) => `    - ${b}`).join('\n')
    );
  } else {
    notes.push(
      `llms.txt: ${checkedEntries} entries link to a real guide and none carry a ` +
        'truncated summary or spliced code fragment'
    );
  }
} else {
  problems.push('llms.txt: file is missing.');
}

for (const note of notes) console.log(`  ok  ${note}`);

if (problems.length > 0) {
  console.error('\ndocs:claims FAILED\n');
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

console.log(`\ndocs:claims ok — ${notes.length} check(s) passed.`);
