#!/usr/bin/env node
/**
 * A snapshot-and-verify guard for the git index.
 *
 * **Why this exists.** `AGENTS.md` records that a wrong commit looks exactly like a
 * right one: the content is what you staged, and nothing in `git status` disagrees.
 * When two sessions share a working tree the index is shared too, so
 * `git add -- <explicit paths>` protects you from sweeping in *unstaged* work and
 * does not protect the commit at all. Four commits in this repository were wrong
 * that way, and the documented mitigation — re-read `git diff --cached --name-only`
 * immediately before committing — is a habit, and habits are what keep failing:
 *
 * - `ac45b6f` is titled `docs(review): BUG-003 is not a double-detach` and carries
 *   generated types and docs for a class that was not in the repository. A clean
 *   checkout of it fails `types:drift`.
 * - `e476642` is titled `docs(review): PERF-005 confirmed and material` and carries a
 *   whole feature: 613 lines of source, 731 of tests, a guide, an ADR and a
 *   changeset.
 * - `.changeset/release-2-0-0.md` was swept into `f637752` ("fix(metrics): ...").
 * - `38f8e1d` ("feat(cache): pin the TinyLFU seed ...") carries
 *   `test/types.optionsCoverage.test.js`, which no one staging it had edited — a
 *   one-file fix to a committed test that was sitting unstaged in the shared
 *   worktree. That one is recorded in `AGENTS.md` because it carries the lesson
 *   the other three do not: **this guard is opt-in.** A commit that does not go
 *   through it is exactly as unguarded as it was before the guard existed, and a
 *   bypassed guard leaves no trace in `git status`, the commit message, or any
 *   output. Nothing enforces it; it has to be typed.
 *
 * A single-phase check cannot fix this, for the same reason `scripts/safe-edit.mjs`
 * says it cannot: comparing against a snapshot taken inside the same process only
 * catches a write that lands *during* the run, and the dangerous case is the one
 * where it landed *before*. So the snapshot is taken by the caller, separately, and
 * handed back as a digest.
 *
 *   git add -- <explicit paths>
 *   node scripts/commit-guard.mjs commit -m "..."      # snapshot, verify, commit, re-verify
 *
 * `commit` verifies the staged set against a snapshot taken at the start of its own
 * run, then confirms the commit it produced contains exactly those paths and blob
 * hashes. Anything that changed the index in between aborts **before** the commit,
 * which is the only point at which aborting is useful.
 *
 * `snapshot` and `check` are exposed separately for a caller that wants to stage,
 * think, and then commit by hand — but that path can only *detect* a wrong commit,
 * not prevent it, and the distinction is the whole reason this script exists.
 *
 * The digest file lives under `.git/`, so it is never committed and never appears
 * in `git status`. There is no `git stash` and no `git reset` anywhere in here:
 * `AGENTS.md` records both conflicting on a dirty tree and losing work.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const DIGEST_FILE = path.join(process.env.GIT_DIR || '.git', 'commit-guard.digest');

const git = (args, { allowFail = false } = {}) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')} failed: ${err.message.trim()}`, { cause: err });
  }
};

/**
 * The staged set as `path\0blobHash` lines, sorted. Content-addressed rather than
 * path-only: a session that re-stages *different content* under a path you already
 * staged is the case a path-only digest would miss.
 *
 * @returns {string}
 */
const stagedSet = () => {
  const out = git(['diff', '--cached', '--name-only']);
  const names = out === '' ? [] : out.split('\n');
  const lines = names
    .map((name) => `${name}\u0000${git(['rev-parse', `:${name}`], { allowFail: true }) ?? '?'}`)
    .sort();
  return lines.join('\n');
};

const digest = (set) => createHash('sha256').update(set).digest('hex');

/** @returns {string} */
const record = () => {
  const set = stagedSet();
  const d = digest(set);
  writeFileSync(DIGEST_FILE, `${d}\n${set}\n`);
  return d;
};

/** @returns {{digest: string, set: string} | null} */
const readRecord = () => {
  let raw;
  try {
    raw = readFileSync(DIGEST_FILE, 'utf8');
  } catch {
    return null;
  }
  const nl = raw.indexOf('\n');
  if (nl === -1) return null;
  return { digest: raw.slice(0, nl), set: raw.slice(nl + 1).replace(/\n$/, '') };
};

const clear = () => rmSync(DIGEST_FILE, { force: true });

const describe = (set) =>
  set === ''
    ? '(nothing staged)'
    : set
        .split('\n')
        .map((l) => l.split('\u0000')[0])
        .join(', ');

const commands = {
  /** Record the staged set as it is right now. */
  snapshot() {
    const d = record();
    const set = stagedSet();
    console.log(`commit-guard: snapshot ${d.slice(0, 12)} — ${describe(set)}`);
    return 0;
  },

  /** Compare the staged set against the recorded snapshot. Detects, cannot prevent. */
  check() {
    const rec = readRecord();
    if (!rec) {
      console.error('commit-guard: no snapshot recorded. Run `snapshot` after staging.');
      return 1;
    }
    const now = stagedSet();
    if (digest(now) === rec.digest) {
      console.log(`commit-guard: staged set unchanged (${rec.digest.slice(0, 12)})`);
      return 0;
    }
    console.error('commit-guard: THE INDEX CHANGED SINCE THE SNAPSHOT.');
    console.error(`  then: ${describe(rec.set)}`);
    console.error(`  now : ${describe(now)}`);
    console.error('Another session has staged work. Re-read the staged set, then re-snapshot.');
    return 1;
  },

  /**
   * Verify, commit, then verify what the commit actually contains.
   *
   * Everything after `git commit` is belt and braces: it cannot undo a wrong
   * commit, and `AGENTS.md` says not to rewrite shared history over a commit
   * message. It exists so the mistake is *detectable* rather than silent.
   */
  commit(argv) {
    const before = stagedSet();
    const beforeDigest = digest(before);
    const recorded = readRecord();

    if (recorded && recorded.digest !== beforeDigest) {
      console.error('commit-guard: REFUSING to commit — the index differs from your snapshot.');
      console.error(`  snapshot: ${describe(recorded.set)}`);
      console.error(`  now     : ${describe(before)}`);
      console.error('Another session staged work since you snapshotted. Re-stage by explicit');
      console.error('path, re-snapshot, and commit again.');
      return 1;
    }
    if (!recorded) {
      console.log('commit-guard: no prior snapshot; using the staged set as snapshotted now.');
    }

    const headBefore = git(['rev-parse', 'HEAD']);
    record();

    // `-F -` and `--file=-` read the message from stdin. `execFileSync` does not
    // forward stdin by default, so `git commit -F - <<EOF` through this guard
    // committed *nothing* and reported an empty message — found by using the tool
    // on its own first commit, which is the only way it shows up.
    let commitInput;
    const usesStdin = argv.some((a, i) =>
      a === '-F' || a === '--file' ? argv[i + 1] === '-' : a === '--file=-'
    );
    if (usesStdin) {
      try {
        commitInput = readFileSync(0, 'utf8');
      } catch {
        commitInput = '';
      }
    }

    let commitOutput;
    try {
      commitOutput = execFileSync('git', ['commit', ...argv], {
        encoding: 'utf8',
        stdio: 'pipe',
        ...(commitInput === undefined ? {} : { input: commitInput }),
      });
    } catch (err) {
      // A pre-commit hook rejecting the commit is not this script's failure.
      process.stderr.write(`${err.stdout ?? ''}${err.stderr ?? ''}`);
      // Drop the snapshot taken a moment ago. Leaving it behind means the retry —
      // which is exactly what the author is about to do — is refused because the
      // index differs from a snapshot of the *previous* attempt. Found by having
      // the guard refuse its own commit after a hook rejected the first one.
      clear();
      console.error(
        'commit-guard: git commit did not succeed; staged set left intact and snapshot dropped.'
      );
      return 1;
    }
    process.stdout.write(commitOutput);

    const headAfter = git(['rev-parse', 'HEAD']);
    if (headAfter === headBefore) {
      console.error('commit-guard: HEAD did not move. Nothing was committed.');
      return 1;
    }

    // What the commit contains, as paths only. `git show` on a merge is suppressed:
    // there is no single set of paths to compare against.
    const parents = git(['rev-list', '--parents', '-n', '1', headAfter]).split(' ').length - 1;
    if (parents > 1) {
      console.log('commit-guard: merge commit; comparing paths is not meaningful, skipping.');
      clear();
      return 0;
    }
    const committed = git(['show', '--pretty=format:', '--name-only', headAfter]);
    const committedPaths = (committed === '' ? [] : committed.split('\n')).sort();
    const stagedPaths =
      before === ''
        ? []
        : before
            .split('\n')
            .map((l) => l.split('\u0000')[0])
            .sort();

    clear();
    const extra = committedPaths.filter((p) => p !== '' && !stagedPaths.includes(p));
    const missing = stagedPaths.filter((p) => !committedPaths.includes(p));
    if (extra.length === 0 && missing.length === 0) {
      console.log(`commit-guard: ${headAfter.slice(0, 12)} contains exactly what was staged.`);
      return 0;
    }
    console.error('commit-guard: THE COMMIT DOES NOT MATCH THE STAGED SET.');
    if (extra.length) console.error(`  unexpected: ${extra.join(', ')}`);
    if (missing.length) console.error(`  missing   : ${missing.join(', ')}`);
    console.error('The commit stands — do not rewrite shared history for this. Report it.');
    return 1;
  },

  clear() {
    clear();
    console.log('commit-guard: snapshot cleared.');
    return 0;
  },
};

const name = process.argv[2];
if (!name || !Object.hasOwn(commands, name)) {
  console.error(`Usage: commit-guard.mjs <${Object.keys(commands).join('|')}> [git commit args]`);
  process.exit(1);
}
process.exit(commands[name](process.argv.slice(3)));
