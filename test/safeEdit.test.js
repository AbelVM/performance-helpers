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
