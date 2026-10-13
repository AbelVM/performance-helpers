#!/usr/bin/env node
/**
 * The Node floor must not be raised by a syntax the floor cannot parse.
 *
 * ## The problem this was written for
 *
 * CI runs the gate on a `['22.12', '24']` matrix, and the 22.12 leg was red with
 * seven failed *suites*: `powerQueue`, `powerSequencer`, `powerPriorityQueue`,
 * `powerHeartbeat`, `powerFlowControl`, `powerFlowController` and
 * `powerRateLimit.keyed` each used a `using` or `await using` declaration.
 *
 * Explicit Resource Management is ES2026 — V8 13.x, Node 24. On 22.12 those
 * declarations are a **SyntaxError**, and a syntax error is not a test failure:
 * it fails the whole file at import time, before a single assertion runs. That
 * is why the earlier fix for this floor (`c81a015`) could gate `Error.isError`
 * and `worker_threads.locks` behind `it.runIf(...)` capability probes and had to
 * *rewrite* the `using` usages instead — a probe cannot help when the file does
 * not parse.
 *
 * The failure was invisible locally for exactly the reason it is dangerous: a
 * maintainer on Node 24 runs the suite green, because Node 24 has the syntax.
 * Only the matrix leg noticed, and only after a push.
 *
 * ## Why a parse and not a grep
 *
 * A regex for `using x =` matches the word inside a comment, a string, a
 * property name and a JSDoc example — and this repository documents `await using`
 * support in JSDoc in at least six helpers, so a grep would fail on a clean tree
 * and be disabled within a week. TypeScript is already a devDependency and its
 * parser is the same one `test:types` uses, so the AST is free and exact: a
 * `using` declaration is a `VariableDeclarationList` carrying a `UsingKeyword`
 * modifier, and comments and strings are not nodes.
 *
 * ## Why it reads the floor
 *
 * `engines.node` is the declaration of what this package supports. When the floor
 * rises to 24 the syntax becomes legal and this check must stop firing — so it
 * reads the floor rather than hard-coding a version, and a raised floor disables
 * it automatically instead of leaving a blocker behind for someone to argue with.
 *
 * @module scripts/check-node-floor
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');

/**
 * The major version this package declares as its floor, from `engines.node`.
 * Returns `null` when it cannot be determined, which is treated as "unknown" and
 * enforced rather than waived — see the note at the call site.
 *
 * @returns {number|null}
 */
function declaredFloorMajor() {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const range = pkg?.engines?.node;
  if (typeof range !== 'string') return null;
  // `>=22.12.0`, `^22.12.0`, `22.x`, `22` — the first integer in the range is
  // the floor in every form this field is written in.
  const match = range.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Every `.js` file under `dir`, recursively.
 *
 * `readdirSync({ recursive: true })` is Node 20+, which is below the floor, so it
 * is available everywhere this script can run.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function jsFiles(dir) {
  const abs = path.join(repoRoot, dir);
  /** @type {string[]} */
  const out = [];
  /** @param {string} current */
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // a directory that does not exist is not a finding
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(abs);
  return out;
}

/**
 * `using` / `await using` declarations in one file, as `{ line, await }`.
 *
 * @param {string} file
 * @returns {{line: number, await: boolean}[]}
 */
function usingDeclarations(file) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  /** @type {{line: number, await: boolean}[]} */
  const found = [];

  /**
   * @param {ts.Node} node
   */
  const walk = (node) => {
    // TypeScript models `using x = …` as an ordinary variable declaration list
    // whose first token is the `using` keyword, not as a distinct node kind —
    // `SyntaxKind.UsingDeclaration` does not exist in TS 6. So the modifier is
    // read off the token list rather than off `node.kind`.
    if (node.kind === ts.SyntaxKind.VariableDeclarationList) {
      const tokens = node.getChildren(source).map((child) => child.kind);
      if (tokens.includes(ts.SyntaxKind.UsingKeyword)) {
        found.push({
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          await: tokens.includes(ts.SyntaxKind.AwaitKeyword),
        });
      }
    }
    ts.forEachChild(node, walk);
  };

  walk(source);
  return found;
}

const floor = declaredFloorMajor();
const HAS_ERM = floor !== null && floor >= 24;

if (HAS_ERM) {
  console.log(
    `check-node-floor: ok — engines.node floor is ${floor}, which has Explicit` +
      ' Resource Management, so `using` is legal and this check no longer applies.'
  );
  process.exit(0);
}

// An unreadable floor is enforced rather than waived. Waiving on "cannot tell"
// is how a gate becomes decorative: the one run where `engines` is malformed is
// the one run where someone is editing it, which is also the run most likely to
// introduce the syntax.
if (floor === null) {
  console.error('check-node-floor: cannot read a major version from engines.node.');
  console.error('  Enforcing the check anyway. Fix `engines.node`, or raise the');
  console.error('  floor to 24+ if the syntax is now intended.');
}

const DIRECTORIES = ['src', 'test', 'bench', 'scripts'];
/** @type {{file: string, line: number, await: boolean}[]} */
const offenders = [];

for (const dir of DIRECTORIES) {
  for (const file of jsFiles(dir)) {
    for (const found of usingDeclarations(file)) {
      offenders.push({ file: path.relative(repoRoot, file), ...found });
    }
  }
}

if (offenders.length === 0) {
  console.log(
    `check-node-floor: ok — no \`using\` / \`await using\` in ${DIRECTORIES.join(', ')}` +
      ` (floor ${floor ?? 'unknown'}).`
  );
  process.exit(0);
}

console.error(
  `check-node-floor: ${offenders.length} \`using\` declaration(s) below the Node floor.\n`
);
console.error('  Explicit Resource Management is ES2026 (V8 13.x, Node 24). On the');
console.error('  declared floor these are a SyntaxError, which fails the whole file at');
console.error('  import time — not one test, and not something `it.runIf()` can gate.');
console.error('  A maintainer on Node 24 runs green, so only the CI matrix leg notices.\n');
for (const o of offenders) {
  console.error(`    ${o.file}:${o.line}  ${o.await ? 'await using' : 'using'}`);
}
console.error('\n  Rewrite as an explicit teardown, which is what the scope exit does:');
console.error('      const x = new Thing();');
console.error('      try {');
console.error('        ...');
console.error('      } finally {');
console.error('        x[Symbol.dispose]();            // or: await x[Symbol.asyncDispose]()');
console.error('      }');
console.error('\n  Or raise `engines.node` to 24+, which retires this check.');
process.exit(1);
