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

describe('--expect declares what a commit is for, and is checked before it', () => {
  // Added after a commit titled 'ten dispose() methods now neutralise through one
  // helper' turned out to contain an entire 783-line helper a concurrent session had
  // in flight: `git add -- src/helpers/` staged a **directory**, which is `git add -A`
  // scoped to one folder. The digest check passed, because the staged set and the
  // commit did match — the set was simply the wrong set. Verifying content cannot catch
  // that; declaring intent can.
  it('refuses when the index holds a path --expect did not declare', () => {
    write('mine.js', '// mine');
    write('theirs.js', '// theirs');
    const head = git(['rev-parse', 'HEAD']);
    const stderr = guardFail(['commit', '--expect', 'mine.js', '-m', 'only mine']);
    expect(stderr).toMatch(/NOT declared/);
    expect(stderr).toMatch(/theirs\.js/);
    // The whole point: refused **before** the commit, so nothing was created.
    expect(git(['rev-parse', 'HEAD'])).toBe(head);
  });

  it('commits when the index matches, and does not pass --expect to git', () => {
    write('only.js', '// only');
    guard(['commit', '--expect', 'only.js', '-m', 'just the one']);
    expect(git(['log', '-1', '--pretty=%s'])).toBe('just the one');
    // If the flag leaked through, git would have rejected it as unknown.
    expect(git(['show', '--stat', '--pretty=%s', 'HEAD'])).toContain('only.js');
  });
});

describe('a staged deletion is content-addressed, not just named', () => {
  /**
   * The digest is documented as content-addressed "rather than path-only", and for a
   * **deletion** it was not.
   *
   * `stagedSet()` was built from `git diff --cached --name-only` plus one
   * `git rev-parse :<path>` per entry. A staged deletion has no index entry, so
   * `rev-parse :path` exits 128. Three consequences, all observed while committing
   * `c755cd4`:
   *
   * - `execFileSync` inherits stderr by default, so the tolerated failure printed
   *   `fatal: ambiguous argument` into the middle of a **successful** commit.
   * - The blob fell back to the literal `'?'`, so the deleted file's contents were
   *   absent from the digest entirely. Two sessions deleting *different* content at
   *   the same path produced the **same** digest — precisely the substitution the
   *   content-addressing exists to catch.
   * - It cost one subprocess per staged path.
   *
   * It is now a single `git diff --cached --raw -z`, which carries both blob hashes
   * for every case, and stderr is captured rather than inherited.
   */
  const digestAfterDeleting = (contents) => {
    write('victim.js', contents);
    git(['commit', '-q', '-m', `add victim: ${contents}`]);
    git(['rm', '-q', 'victim.js']);
    const out = guard(['snapshot']);
    return out.match(/snapshot ([0-9a-f]{12})/)[1];
  };

  it('gives two different deletions of the same path two different digests', () => {
    // The property the old code lacked. Both states are *one staged deletion of
    // `victim.js`* and nothing else, so the only thing that can move the digest is
    // the content of the file being removed.
    const a = digestAfterDeleting('the original contents');
    const b = digestAfterDeleting('DIFFERENT contents at the same path');
    expect(b).not.toBe(a);
  });

  it('is stable across two snapshots of the same deletion', () => {
    // The other half: a digest that changes when nothing did would refuse every
    // commit, which is the failure mode a weak fix trades into.
    write('victim.js', 'stable contents');
    git(['commit', '-q', '-m', 'add victim']);
    git(['rm', '-q', 'victim.js']);
    expect(guard(['snapshot'])).toBe(guard(['snapshot']));
  });

  it('refuses outside a repository, and says so in one line', () => {
    // The stderr leak, pinned as behaviour rather than as a string.
    //
    // The first version of this test snapshotted a deletion *inside* a repo and
    // asserted no `fatal:` appeared — which passed vacuously once `stagedSet()`
    // stopped calling a git command that can fail. Asserting on a diagnostic that
    // can no longer be produced is decoration, so this drives a case where git
    // genuinely fails: outside a repository, `git diff --cached` exits non-zero.
    //
    // Two properties, both of which the old code got wrong in opposite directions.
    // It **exited 1** already, so the guard was never vacuous here — good, and worth
    // pinning. But it did so by throwing, which printed a Node stack trace wrapping
    // git's entire `diff --help`: 200-odd lines in which the single line naming the
    // failure is one line. `git()` now keeps only git's first stderr line, and the
    // CLI catches rather than throwing.
    const bare = mkdtempSync(path.join(tmpdir(), 'commit-guard-bare-'));
    try {
      let stderr = '';
      let status = 0;
      try {
        execFileSync('node', [SCRIPT, 'snapshot'], { cwd: bare, encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        stderr = err.stderr ?? '';
        status = err.status;
      }
      expect(status, 'must not pass vacuously outside a repository').toBe(1);
      expect(stderr.trim().split('\n'), 'one line, not a stack trace').toHaveLength(1);
      expect(stderr).toMatch(/^commit-guard: git diff .* failed:/);
      // The command is named, so the reader knows what to go look at.
      expect(stderr).toMatch(/diff --cached --raw -z/);
      expect(stderr).not.toMatch(/usage: git diff/);
      expect(stderr).not.toMatch(/at .*\(.*:\d+:\d+\)/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('still lists a deleted path, and still commits it', () => {
    // The guard reporting a deletion correctly, end to end. Before the fix the path
    // was listed too — but with a `?` where its content should have been, and the
    // stderr noise made the output look like a failure.
    //
    // `keep.js` has to be *modified after* the commit to appear at all: it was
    // written into that commit, so it matches HEAD and `git diff --cached` correctly
    // omits it. An earlier draft staged a deletion alongside an untouched file and
    // asserted both were listed, which is an assertion about a file git never staged.
    write('victim.js', 'removed');
    git(['commit', '-q', '-m', 'add both']);
    write('keep.js', 'kept, and changed since');
    git(['rm', '-q', 'victim.js']);
    const listed = guard(['snapshot']);
    expect(listed).toMatch(/victim\.js/);
    expect(listed).toMatch(/keep\.js/);

    guard(['commit', '-m', 'drop the victim']);
    // And git agrees the file is gone, rather than the guard merely claiming so.
    expect(git(['show', '--name-only', '--pretty=', 'HEAD']).split('\n').sort()).toEqual(
      ['keep.js', 'victim.js'].sort()
    );
    expect(() => git(['cat-file', '-e', 'HEAD:victim.js'])).toThrow();
  });

  it('records a rename as both paths, so neither side can go missing', () => {
    // `--raw -z` emits two paths for a rename or copy, where `--name-only` also emits
    // two. Handled as the delete-then-add it actually is, so one digest line still
    // means one path and `describe()` still prints one name.
    write('before.js', '// same contents');
    git(['commit', '-q', '-m', 'add before.js']);
    git(['mv', 'before.js', 'after.js']);
    const listed = guard(['snapshot']);
    expect(listed).toMatch(/before\.js/);
    expect(listed).toMatch(/after\.js/);
  });
});

describe('a heredoc message survives --expect', () => {
  /**
   * `-F -` reads the commit message from stdin, which `execFileSync` does not
   * forward by default, so the guard reads it itself and passes it in.
   *
   * **The lookahead indexed the wrong array.** `--expect a,b` removes two entries
   * from `argv` to build `rest`, so a position taken from `rest` and applied to
   * `argv` is off by two and lands on the declared paths. `usesStdin` was therefore
   * false whenever `--expect` was present, no message was read, and `git commit`
   * aborted with *"Aborting commit due to empty commit message"*.
   *
   * Worth being precise about how this failed, because it is the good version: the
   * guard **refused** rather than committing something wrong, and it left the staged
   * set intact. Found by using the tool with `--expect` and a heredoc — which is the
   * exact combination `AGENTS.md` prescribes for a shared working tree, so the
   * documented workflow was the broken one. The pre-existing stdin test passes
   * because it does not use `--expect`.
   */
  const guardWithStdin = (args, message) =>
    execFileSync('node', [SCRIPT, ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: message,
    });

  it('forwards the message when --expect is also given', () => {
    write('mine.js', '// mine');
    guardWithStdin(
      ['commit', '--expect', 'mine.js', '-F', '-'],
      'a message written with a heredoc\n'
    );
    expect(git(['log', '-1', '--pretty=%B']).trim()).toBe('a message written with a heredoc');
  });

  it('still refuses a wrong index with a heredoc, before the commit', () => {
    // The refusal has to survive the stdin path too — otherwise fixing the lookahead
    // would have quietly turned `--expect` into a no-op whenever the message came from
    // a pipe, which is a far worse failure than an empty commit message.
    write('mine.js', '// mine');
    write('theirs.js', '// theirs');
    const head = git(['rev-parse', 'HEAD']);
    let stderr = '';
    try {
      guardWithStdin(['commit', '--expect', 'mine.js', '-F', '-'], 'should not land\n');
    } catch (err) {
      stderr = err.stderr ?? '';
      expect(err.status).toBe(1);
    }
    expect(stderr).toMatch(/NOT declared/);
    expect(stderr).toMatch(/theirs\.js/);
    expect(git(['rev-parse', 'HEAD'])).toBe(head);
  });

  it('a multi-line message survives intact', () => {
    // A heredoc is chosen for multi-line messages, so a truncated or single-lined
    // message would be a partial fix. Asserted on the body git actually recorded.
    //
    // Compared with trailing whitespace stripped, because **git** normalises the
    // recorded message that way — `%B` drops the final newline. Asserting the raw
    // form tested git rather than the guard, and the first draft failed on exactly
    // that while the interior newlines were present and correct. The interior is the
    // property that matters and it is compared exactly.
    write('mine.js', '// mine');
    const message = 'subject line\n\nbody paragraph one\nbody paragraph two\n';
    guardWithStdin(['commit', '--expect', 'mine.js', '-F', '-'], message);
    expect(git(['log', '-1', '--pretty=%B']).replace(/\s+$/, '')).toBe(message.replace(/\s+$/, ''));
    // And the blank line separating subject from body survived, which a
    // line-joining bug would have eaten.
    expect(git(['log', '-1', '--pretty=%B'])).toContain('subject line\n\nbody paragraph one');
  });
});
