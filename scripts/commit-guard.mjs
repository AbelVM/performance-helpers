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

/**
 * Run `git` and return its trimmed stdout.
 *
 * `stdio` is pinned on every call. `execFileSync` **inherits stderr by default**,
 * and that is how a *tolerated* failure printed `fatal: ambiguous argument` into the
 * middle of a successful commit: the caller swallowed the non-zero exit, but the
 * diagnostic had already gone to the terminal. Capturing it means a tolerated failure
 * is silent and a real one is reported below with git's own words attached.
 *
 * There is no `allowFail` option, and that is deliberate. The only caller that wanted
 * one was the `rev-parse :<path>` loop this file no longer has — and an escape hatch
 * nothing reaches is the same "written but never read" shape this repository audits
 * other helpers for. Every git call here is one whose failure means the guard cannot
 * honestly describe the index, so every one of them throws.
 */
const git = (args) => {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    // Only git's own first line. The full stderr is git's entire `diff --help`,
    // because a bad flag or a missing repository sends it — and a 200-line
    // `usage:` dump in place of an error message is how a real failure gets
    // misread as noise and ignored.
    const [first] = `${err.stderr ?? ''}`.split('\n');
    throw new Error(`git ${args.join(' ')} failed: ${first || err.message.trim()}`, {
      cause: err,
    });
  }
};

/**
 * The staged set as `path\0<status>:<srcMode>-><dstMode>:<srcBlob>..<dstBlob>` lines,
 * sorted. Content-addressed rather than path-only: a session that re-stages
 * *different content* under a path you already staged is the case a path-only
 * digest would miss.
 *
 * **One `git diff --cached --raw -z` call, and that is load-bearing.** The first
 * version built this from `--name-only` plus a `git rev-parse :<path>` per entry,
 * which was wrong in three ways at once on a **staged deletion**:
 *
 * - `rev-parse :path` has no index entry for a removed file, so it exits 128. With
 *   `allowFail` the failure was tolerated, but `execFileSync` inherits stderr, so
 *   `fatal: ambiguous argument` was printed into the middle of a *successful*
 *   commit. Observed: three such lines above a clean `c755cd4`.
 * - The blob fell back to the literal `'?'`. So the digest was **not
 *   content-addressed for deletions** — the one property the docstring above
 *   claims it has — and two sessions deleting *different* content at the same path
 *   produced the same digest.
 * - It cost one subprocess per staged path.
 *
 * `--raw -z` answers all three cases in one call with both blob hashes, so a
 * deletion carries its **pre-image** blob (`src`) and an empty post-image, which is
 * what makes the digest content-addressed in the case that matters. A rename or copy
 * emits two paths under `-z` and is recorded as the delete-then-add it actually is,
 * so one line still means one path.
 *
 * @returns {string}
 */
const stagedSet = () => {
  const raw = git(['diff', '--cached', '--raw', '-z']);
  if (raw === '') return '';
  const fields = raw.split('\0');
  /** @type {string[]} */
  const lines = [];
  for (let i = 0; i < fields.length;) {
    const meta = fields[i];
    if (!meta) {
      i += 1;
      continue;
    }
    // `:<srcMode> <dstMode> <srcBlob> <dstBlob> <status>` — the colon is glued to
    // the first mode, so this splits into **five** fields, not six. Writing it as
    // `[, srcMode, …]` yields `undefined` for `status` and throws three lines later,
    // which is the guess-the-shape mistake; it cost one debugging round here.
    //
    // The field-count assertion below is **not covered by a test** — no test can
    // reach it without a malformed `git diff --raw`, and there is no seam to inject
    // one. It is here for diagnosability, not detection: if git ever changes the
    // record layout the message names the offending record instead of the failure
    // surfacing as a `TypeError` about `status`. Recorded here so nobody later
    // assumes a test guards it.
    const parts = meta.replace(/^:/, '').split(' ');
    if (parts.length !== 5) {
      throw new Error(`commit-guard: unrecognised --raw record: ${JSON.stringify(meta)}`);
    }
    const [srcMode, dstMode, srcBlob, dstBlob, status] = parts;
    if (status[0] === 'R' || status[0] === 'C') {
      const from = fields[i + 1];
      const to = fields[i + 2];
      i += 3;
      if (from) lines.push(`${from}\u0000D:${srcMode}->000000:${srcBlob}..00000000`);
      if (to) lines.push(`${to}\u0000${status[0]}:000000->${dstMode}:00000000..${dstBlob}`);
      continue;
    }
    const name = fields[i + 1];
    i += 2;
    if (name) lines.push(`${name}\u0000${status}:${srcMode}->${dstMode}:${srcBlob}..${dstBlob}`);
  }
  return lines.sort().join('\n');
};

const digest = (set) => createHash('sha256').update(set).digest('hex');

/**
 * Snapshot the staged set.
 * @returns {{digest: string, set: string}}
 */
const record = () => {
  const set = stagedSet();
  const d = digest(set);
  writeFileSync(DIGEST_FILE, `${d}\n${set}\n`);
  return { digest: d, set };
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
    // One read, not two. This used to call `stagedSet()` a second time to describe
    // the set it had just snapshotted, so a session that staged work in between got
    // a digest and a message that disagreed — and neither said so.
    const { digest: d, set } = record();
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
    // `--expect a.js,b.js` declares what this commit is *for*, independently of
    // what the index happens to hold. It is checked BEFORE the commit, because the
    // post-commit digest comparison can only report that the index was not what you
    // meant — by then the commit exists.
    //
    // **This exists because it was needed.** A commit titled "ten dispose()
    // methods now neutralise through one helper" was made after `git add --
    // src/helpers/`: a directory, functionally `git add -A` scoped to one folder.
    // It swept in three files a concurrent session had in flight and that the
    // author had never opened — an entire 783-line helper — and the digest check
    // passed, because the staged set and the commit did match each other. The set
    // was simply the wrong set. Verifying content cannot catch that; an
    // independent declaration of intent can.
    const expectAt = argv.indexOf('--expect');
    let expected = null;
    let rest = argv;
    if (expectAt !== -1) {
      const raw = argv[expectAt + 1];
      if (raw === undefined) {
        console.error('commit-guard: --expect needs a comma-separated list of paths.');
        return 1;
      }
      expected = new Set(
        raw
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      );
      rest = argv.filter((_, i) => i !== expectAt && i !== expectAt + 1);
    }

    const before = stagedSet();
    const beforeDigest = digest(before);
    const recorded = readRecord();

    if (expected) {
      // `stagedSet()` returns `name\u0000blobhash` lines joined by newlines, not a bare
      // list of names, so both the separator and the line split matter here. Getting
      // this wrong turns the check into a set of *characters*.
      const staged = new Set(
        before
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('\u0000')[0])
      );
      const missing = [...expected].filter((p) => !staged.has(p));
      const extra = [...staged].filter((p) => !expected.has(p));
      if (missing.length || extra.length) {
        console.error(
          'commit-guard: REFUSING to commit \u2014 the index is not what --expect declared.'
        );
        if (extra.length) {
          console.error('  staged but NOT declared:');
          for (const p of extra) console.error(`    ${p}`);
        }
        if (missing.length) {
          console.error('  declared but NOT staged:');
          for (const p of missing) console.error(`    ${p}`);
        }
        console.error('A staged path you did not intend is how another session work gets');
        console.error('committed under your message. Add the paths you mean and commit again.');
        return 1;
      }
      console.log(`commit-guard: index matches the ${expected.size} declared path(s).`);
    }

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
    //
    // **The lookahead must index `rest`, not `argv`.** `--expect a,b` removes two
    // entries from `argv` to build `rest`, so an index taken from `rest` and applied
    // to `argv` is off by two and lands on the path list. That made `usesStdin`
    // false whenever `--expect` was present, so the documented shared-tree workflow
    // — `commit-guard commit --expect a,b -m "..."`, and the heredoc form of it —
    // silently committed an empty message and git refused it. The guard refused
    // correctly; the message was simply gone. Found by using the tool with
    // `--expect` and a heredoc, which is the combination `AGENTS.md` tells you to use.
    let commitInput;
    const usesStdin = rest.some((a, i) =>
      a === '-F' || a === '--file' ? rest[i + 1] === '-' : a === '--file=-'
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
      commitOutput = execFileSync('git', ['commit', ...rest], {
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

// A git failure — a missing repository, an unknown flag, a locked index — arrives as
// a thrown `Error`, and an uncaught throw prints a Node stack trace around it. That is
// the wrong output for a tool whose entire job is to be trustworthy under pressure:
// the one line that says *what went wrong* is buried in 200 lines of frame list, and
// `git diff --help` arrives with it. Exit 1 either way, but the reason is now readable.
try {
  process.exit(commands[name](process.argv.slice(3)));
} catch (err) {
  console.error(`commit-guard: ${err.message}`);
  process.exit(1);
}
