import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * `scripts/safe-edit.mjs` — the guard for hand-editing files another session may
 * be writing.
 *
 * **These tests exist because the tool's whole value is in paths that are hard to
 * exercise by accident.** Every one of them is a mutation of the tool rather than
 * of the library: change the digest check and the stale-edit test below still
 * passes only if the refusal text is also checked; remove the no-op guard and a
 * patch that silently does nothing looks exactly like success.
 *
 * The prompt for the tool was an incident, not a theory: a hand-written edit to
 * `review_04.md` reverted a concurrent session's section renumbering, and the
 * `mtime` guard in `close-review-row.mjs` could not prevent it because that guard
 * protects the *script*, not the habit.
 */

const TOOL = path.resolve('scripts/safe-edit.mjs');
let dir;
let file;

/** Run the tool, returning `{status, out}` without throwing on a refusal. */
function run(...args) {
  try {
    const out = execFileSync('node', [TOOL, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** Snapshot the file and return its digest. */
const snapOf = (f) => {
  const { out } = run('snapshot', '--file', f);
  return out.match(/digest {2}: ([0-9a-f]{64})/)?.[1] ?? '';
};

const snap = () => {
  const { out } = run('snapshot', '--file', file);
  return out.match(/digest {2}: ([0-9a-f]{64})/)?.[1] ?? '';
};

/** Write a patch module that runs `body`. */
function patch(name, body) {
  const p = path.join(dir, name);
  writeFileSync(p, `export default (t) => { ${body} };\n`);
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'safe-edit-'));
  file = path.join(dir, 'shared.md');
  writeFileSync(file, 'line one\nline two\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('safe-edit: a stale edit is refused, not applied', () => {
  it('refuses when the file changed after the snapshot, and leaves it untouched', () => {
    // **The case the tool exists for.** Someone else wrote between `snapshot` and
    // `apply`; my edit was composed against a version that no longer exists.
    const digest = snap();
    writeFileSync(file, 'line one\nline two\nTHEIR CHANGE\n');

    const { status, out } = run(
      'apply',
      '--file',
      file,
      '--expect',
      digest,
      '--patch',
      patch('append.mjs', "return t + 'MINE\\n';")
    );

    expect(status).toBe(1);
    expect(out).toMatch(/REFUSED/);
    expect(out).toMatch(/revert their work/);
    // The load-bearing assertion: their line is still there and mine is not.
    expect(readFileSync(file, 'utf8')).toContain('THEIR CHANGE');
    expect(readFileSync(file, 'utf8')).not.toContain('MINE');
  });

  it('applies when the digest still matches', () => {
    // The other half. A guard that refuses everything is not a guard, it is an
    // obstacle, and this is what stops it being one.
    const digest = snap();
    const { status } = run(
      'apply',
      '--file',
      file,
      '--expect',
      digest,
      '--patch',
      patch('append.mjs', "return t + 'MINE\\n';")
    );

    expect(status).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('MINE');
  });

  it('keeps a backup next to the file, so the edit is revertible with cp', () => {
    // `git stash` is the documented wrong answer here: AGENTS.md records it
    // conflicting on a dirty tree and losing work.
    const { out } = run('snapshot', '--file', file);
    expect(out).toMatch(/backup {2}: /);
    expect(readdirSync(dir).some((f) => f.includes('.bak-'))).toBe(true);
  });
});

describe('safe-edit: a patch that lands on nothing is a failure, not a success', () => {
  it('refuses when the patch changes nothing', () => {
    // A stale anchor produces an identical string, and writing it would exit 0 and
    // look like the edit landed. This is the failure mode that makes a "did my
    // edit apply?" question unanswerable from the outside.
    const digest = snap();
    const { status, out } = run(
      'apply',
      '--file',
      file,
      '--expect',
      digest,
      '--patch',
      patch('noop.mjs', 'return t;')
    );

    expect(status).toBe(1);
    expect(out).toMatch(/produced no change/);
    expect(readFileSync(file, 'utf8')).toBe('line one\nline two\n');
  });

  it('propagates a patch that throws, and writes nothing', () => {
    // The patch author is told to check their own anchor; this proves that doing
    // so is what stops a silent no-op, and that a throw cannot half-apply.
    const digest = snap();
    const p = patch(
      'stale.mjs',
      "if (!t.includes('NOT PRESENT')) throw new Error('anchor absent'); return t;"
    );

    const { status, out } = run('apply', '--file', file, '--expect', digest, '--patch', p);

    expect(status).toBe(1);
    expect(out).toMatch(/anchor absent/);
    expect(readFileSync(file, 'utf8')).toBe('line one\nline two\n');
  });
});

describe('safe-edit: a patch that succeeds and deletes a landmark', () => {
  // **This is the failure mode the other two guards cannot see.** Three attempts
  // to patch `bench/claims.js` computed an end index that swallowed the `MODES`
  // table and `dispatch()`, and the file died with
  // `ReferenceError: dispatch is not defined`. Every one of those patches
  // *changed* the file, so the digest check passed (nothing else had touched it)
  // and the no-change check passed (it did change). Both guards said nothing was
  // wrong while the file was destroyed.
  //
  // Reproduced here with the smallest version of that mistake: a patch anchored on
  // a marker that appears twice, taking the first, which silently truncates
  // everything after it.
  const LANDMARK = 'export function dispatch() {';
  const FILE = 'const a = 1;\nMARKER\nconst b = 2;\nMARKER\n' + LANDMARK + '\nconst c = 3;\n';

  let landmarkFile;
  beforeEach(() => {
    landmarkFile = path.join(dir, 'claims.js');
    writeFileSync(landmarkFile, FILE);
  });

  const patchTakingFirstMarker = () =>
    patch('truncate.mjs', "const i = t.indexOf('MARKER'); return t.slice(0, i);");

  it('refuses when a required landmark would be removed, and writes nothing', () => {
    const digest = snapOf(landmarkFile);
    const { status, out } = run(
      'apply',
      '--file',
      landmarkFile,
      '--expect',
      digest,
      '--must-contain',
      LANDMARK,
      '--patch',
      patchTakingFirstMarker()
    );

    expect(status).toBe(1);
    expect(out).toMatch(/REFUSED/);
    expect(out).toMatch(/required string/);
    expect(out).toMatch(/Nothing was written/);
    // The load-bearing assertion: the landmark is still in the file.
    expect(readFileSync(landmarkFile, 'utf8')).toContain(LANDMARK);
  });

  it('allows the same patch when the landmark is not required', () => {
    // Otherwise the flag reads as "refuse everything", which is the failure mode
    // of every guard added so far — including the digest check before it had a
    // test for the passing path.
    const digest = snapOf(landmarkFile);
    const { status } = run(
      'apply',
      '--file',
      landmarkFile,
      '--expect',
      digest,
      '--patch',
      patchTakingFirstMarker()
    );

    expect(status).toBe(0);
    expect(readFileSync(landmarkFile, 'utf8')).not.toContain(LANDMARK);
  });

  it('checks every value, and names all of the missing ones', () => {
    const digest = snapOf(landmarkFile);
    const { status, out } = run(
      'apply',
      '--file',
      landmarkFile,
      '--expect',
      digest,
      '--must-contain',
      `${LANDMARK}|const c = 3;|const zzz = 9;`,
      '--patch',
      patch('append.mjs', "return t + 'APPENDED\\n';")
    );

    expect(status).toBe(1);
    // One missing value is enough to refuse; both are reported, so a reader does
    // not have to re-run to discover the second.
    expect(out).toMatch(/const zzz = 9;/);
    expect(out).toMatch(/required string/);
    expect(readFileSync(landmarkFile, 'utf8')).not.toContain('APPENDED');
  });

  it('passes when every required landmark survives', () => {
    const digest = snapOf(landmarkFile);
    const { status } = run(
      'apply',
      '--file',
      landmarkFile,
      '--expect',
      digest,
      '--must-contain',
      `${LANDMARK}|const c = 3;`,
      '--patch',
      patch('append.mjs', "return t + 'APPENDED\\n';")
    );

    expect(status).toBe(0);
    expect(readFileSync(landmarkFile, 'utf8')).toContain('APPENDED');
    expect(readFileSync(landmarkFile, 'utf8')).toContain(LANDMARK);
  });
});

describe('safe-edit: usage', () => {
  it('prints its own usage rather than failing obscurely', () => {
    const { out } = run();
    expect(out).toMatch(/snapshot --file/);
    expect(out).toMatch(/apply {4}--file/);
  });

  it('refuses a patch module that does not export a function', () => {
    // Otherwise the failure is a TypeError deep in the tool, which reads like a
    // tool bug rather than a caller mistake.
    const digest = snap();
    const p = path.join(dir, 'bad.mjs');
    writeFileSync(p, 'export default 42;\n');

    const { status, out } = run('apply', '--file', file, '--expect', digest, '--patch', p);

    expect(status).toBe(1);
    expect(out).toMatch(/must export a default function/);
  });
});
