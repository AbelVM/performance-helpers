import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/commit-guard.mjs`.
 *
 * The guard exists because four commits in this repository were wrong in exactly
 * the way it detects: `ac45b6f`, `e476642`, a changeset swept into `f637752`,
 * and `38f8e1d` — which carried a committed test nobody staging it had edited,
 * and did so while this guard was already written. So the test that matters is
 * not "does it run" — it is **does it refuse**, and does it refuse *before* the
 * commit rather than after.
 *
 * Every case builds a throwaway repository. Nothing here touches the real index,
 * which is the whole hazard the script is about.
 */
const SCRIPT = fileURLToPath(new URL('../scripts/commit-guard.mjs', import.meta.url));

let repo;

const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const guard = (args, cwd = repo) =>
  execFileSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });

/** Runs the guard expecting failure, returning its stderr. */
const guardFail = (args, cwd = repo) => {
  let stderr = null;
  try {
    execFileSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    stderr = err.stderr ?? '';
    expect(err.status).toBe(1);
  }
  expect(stderr, `expected \`commit-guard ${args.join(' ')}\` to fail`).not.toBeNull();
  return stderr;
};

const write = (name, content) => {
  writeFileSync(path.join(repo, name), content);
  git(['add', '--', name]);
};

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'commit-guard-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(path.join(repo, 'README.md'), 'first\n');
  git(['add', '--', 'README.md']);
  git(['commit', '-q', '-m', 'initial']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('commit-guard', () => {
  it('commits when the index is exactly what was staged', () => {
    write('a.txt', 'mine\n');
    const out = guard(['commit', '-m', 'my commit']);
    expect(out).toContain('contains exactly what was staged');
    expect(git(['log', '-1', '--pretty=%s'])).toBe('my commit');
    expect(git(['show', '--pretty=format:', '--name-only', 'HEAD']).trim()).toBe('a.txt');
  });

  it('refuses when another session staged work after the snapshot', () => {
    // **The case it exists for.** Snapshot taken, then a concurrent session adds
    // its own file to the shared index, then the commit is attempted.
    write('mine.txt', 'mine\n');
    guard(['snapshot']);
    write('theirs.txt', 'theirs\n');

    const stderr = guardFail(['commit', '-m', 'my commit']);
    expect(stderr).toContain('REFUSING to commit');
    expect(stderr).toContain('theirs.txt');
    // The refusal has to come *before* the commit, or it is a report card rather
    // than a guard.
    expect(git(['log', '-1', '--pretty=%s'])).toBe('initial');
    expect(git(['diff', '--cached', '--name-only'])).toContain('mine.txt');
  });

  it('re-staging different content under a path already staged is also caught', () => {
    // A path-only digest would miss this: the path list is identical, only the
    // content differs. That is why the digest is content-addressed.
    write('mine.txt', 'version one\n');
    guard(['snapshot']);
    write('mine.txt', 'version two\n');
    const stderr = guardFail(['commit', '-m', 'my commit']);
    expect(stderr).toContain('REFUSING to commit');
    expect(git(['log', '-1', '--pretty=%s'])).toBe('initial');
  });

  it('names what changed, in both directions', () => {
    // A refusal that only says "something changed" sends the reader back to
    // `git status`, which is the habit that keeps failing.
    write('mine.txt', 'mine\n');
    guard(['snapshot']);
    write('theirs.txt', 'theirs\n');
    const stderr = guardFail(['check']);
    expect(stderr).toContain('THE INDEX CHANGED SINCE THE SNAPSHOT');
    expect(stderr).toMatch(/then:.*mine\.txt/s);
    expect(stderr).toMatch(/now :.*mine\.txt.*theirs\.txt/s);
  });

  it('accepts a commit whose snapshot was never taken, and says so', () => {
    // `commit` must be usable without the two-step dance; it just cannot detect
    // anything that happened before it started.
    write('a.txt', 'x\n');
    const out = guard(['commit', '-m', 'no snapshot']);
    expect(out).toContain('no prior snapshot');
    expect(git(['log', '-1', '--pretty=%s'])).toBe('no snapshot');
  });

  it('leaves the index intact when the commit does not succeed', () => {
    // A pre-commit hook rejecting the commit is not this script's failure, and the
    // staged set must survive so the author can fix and retry.
    write('a.txt', 'x\n');
    mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', {
      mode: 0o755,
    });
    guardFail(['commit', '-m', 'blocked']);
    expect(git(['log', '-1', '--pretty=%s'])).toBe('initial');
    expect(git(['diff', '--cached', '--name-only'])).toBe('a.txt');
    // And the snapshot is dropped, so the retry the author is about to attempt is
    // not refused because the index differs from the *previous* attempt's.
    writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    expect(guard(['commit', '-m', 'retry'])).toContain('contains exactly what was staged');
  });

  it('clears its snapshot so a later commit is not judged against a stale one', () => {
    // Otherwise the second commit in a session fails against the first one's
    // snapshot, which would train people to pass `--no-verify` equivalent habits.
    write('a.txt', 'x\n');
    guard(['commit', '-m', 'one']);
    write('b.txt', 'y\n');
    const out = guard(['commit', '-m', 'two']);
    expect(out).toContain('contains exactly what was staged');
    expect(git(['log', '-1', '--pretty=%s'])).toBe('two');
  });

  it('refuses to check with no snapshot, rather than passing vacuously', () => {
    // A guard that reports success when it has nothing to compare against is
    // worse than no guard: it looks like protection.
    const stderr = guardFail(['check']);
    expect(stderr).toContain('no snapshot recorded');
  });

  it('never writes a file git can see', () => {
    write('a.txt', 'x\n');
    guard(['snapshot']);
    expect(git(['status', '--porcelain'])).toBe('A  a.txt');
  });

  it('forwards a message given with -F -, so a heredoc commit works', () => {
    // Found by using the guard on its own first commit: `execFileSync` does not
    // forward stdin, so `git commit -F - <<EOF` through the guard committed
    // nothing and reported an empty message.
    write('a.txt', 'x\n');
    const res = spawnSync(
      'sh',
      ['-c', `node ${JSON.stringify(SCRIPT)} commit -F - <<'EOF'\nfrom a heredoc\nEOF`],
      { cwd: repo, encoding: 'utf8' }
    );
    expect(res.status, res.stderr).toBe(0);
    expect(git(['log', '-1', '--pretty=%B']).trim()).toBe('from a heredoc');
  });

  it('rejects an unknown subcommand with usage', () => {
    const stderr = guardFail(['nonsense']);
    expect(stderr).toContain('Usage: commit-guard.mjs');
  });
});
