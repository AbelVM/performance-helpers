# AGENTS.md

Guidance for an AI agent (or a person) working in this repository. Written from
the mistakes this project has actually made, not from what a contributor guide
usually says.

## What this is

`performance-helpers` — a dependency-free toolbox of small, fast, Node/browser
libraries: a worker pool, an LRU/TTL cache, rate limiters, a concurrency gate,
zero-copy buffer helpers, a versioned message codec, and a logger. No runtime
dependencies, ESM + CJS bundles, and a typecheck ratchet rather than a type
rewrite.

`package.json` is `1.0.3`; **2.0 is unreleased and the changeset is staged**.

## The three things that will waste your time if you do not know them

**1. `review.md` is gitignored and not in the repository.** It is the working
plan. `test/reviewTable.test.js` guards against its plan table being malformed,
and that test **skips when the file is absent** — so in CI it asserts nothing, and
its section-reference tally was deleted rather than kept, because a test whose
expected value is "whatever an untracked file currently says" is not a test. Do
not add assertions that depend on `review.md`, `notes.md`, `review2.md`,
`.kilo/`, `.zvec-grep/`, or `.vitest/`: they will pass locally and there will be
no file to fail against in CI.

**2. `docs/` is generated _and_ committed.** `npm run docs` rewrites it, and the
project website links into it, so it is tracked despite being 1.7 MB. Never put a
hand-written file there — the next typedoc run buries or deletes it. That is why
`adr/` exists at the root and is deliberately absent from `package.json`'s
`files`.

**3. This project records withdrawn claims.** Several entries in the guides and
in `CHANGELOG.md` exist to say a number was _measured and is wrong_. Do not
"clean up" a sentence that documents a retracted performance claim — it is the
reason the next proposal does not repeat the work.

## Commands

```bash
npm run verify          # the full gate: lint, test, types, ratchet, build, bundle, drift, docs
npm test                # vitest run — ~1726 tests, ~193 files (the gate, not this number)
npm run test:coverage   # what CI runs
npm run test:types      # tsc against the public type tests
npm run lint            # eslint; 0 errors expected, plus a few dozen pre-existing warnings
npm run types:generate  # regenerate types/ — required after any JSDoc change
npm run types:drift     # fails if types/ is out of date
npm run docs            # regenerate docs/ — same trigger, and see the note below
npm run docs:claims     # fails if a guide documents an option the types don't have
npm run docs:drift      # fails if docs/ is out of date
npm run mutants:servo   # 18 PowerServo mutants, each killed by a named test
```

The gate is `scripts/verify.mjs`, and it is the **only** list of checks — eleven
steps. CI calls it rather than keeping its own copy: it did once, and the copies
drifted until CI was running neither `test:types` nor `check:bundle` (see the
comment at the top of `.github/workflows/ci.yml`). **To add a check, add it to
that script**, not to the workflow.

**Two scripts in `scripts/` look like gates and are not.** A script shaped like
a check but wired to nothing is worse than no script, because it reads as
coverage:

- **`npm run review:check` gates nothing.** It is not in `scripts/verify.mjs`,
  not in `.husky/pre-commit`, and not in CI — and it cannot be, because
  `review.md` is **gitignored**, so in a clean checkout the file it reads does
  not exist and `test/reviewTable.test.js` skips itself. There is nothing for a
  gate to assert against. Run it by hand, before you close a row, because it is
  the only thing that will tell you a table row has the wrong number of columns
  or a duplicate id.
- **`npm run audit:exports` is a diagnostic, not a check.** It prints an export
  inventory for a human to read. It asserts nothing and exits 0 on a tree full
  of surprises. Do not add it to `verify.mjs` expecting it to catch something; if
  you want it to catch something, that is new work and it belongs in
  `test/apiSurface.test.js`, which _does_ pin the export list deliberately.

If you add a real gate, add it to `scripts/verify.mjs` — that is the one place
that decides.

`docs:drift` is the one step that **rewrites a committed tree** before comparing
it. `typedoc.json` sets `cleanOutputDir: true`, so it regenerates all 1.7 MB and
_then_ asks whether the commit matched — there is no incremental mode to diff
against, and a bare `git diff -- docs` would pass forever. `git add` the result
before running `verify`, exactly as with `types/`. It compares against the
**index**, not `HEAD`, which is what lets a pre-commit tree pass and a
`--no-verify` or squash-bot tree fail; it also means a polluted index can mask
real drift.

`VERIFY_TEST=test:coverage npm run verify` is what CI runs: the coverage
thresholds in `vitest.config.js` only apply under `--coverage`, so plain
`npm test` does not enforce them. That is the only intended difference between
the two.

`.husky/pre-commit` runs prettier, eslint and lint-staged on staged files, and
regenerates `types/`. A changeset in `.changeset/` is **not** added
automatically — write one.

Benchmarks (each takes minutes, and each is a real measurement, not a smoke test):

```bash
node bench/claims.js zipf        # cache admission policies under Zipf + scan
node bench/claims.js coldstart   # the cold-start case, which answers differently
node bench/claims.js carrier     # message-carrier fidelity and encode cost
node bench/claims.js payload     # why compression does not pay in-process
node bench/claims.js permit      # what a SharedArrayBuffer permit pool would cost
node bench/claims.js stream      # chunking against posting one message
node bench/claims.js sieve       # SIEVE eviction policy, against what ships
node bench/claims.js sketch      # TinyLFU sketch hashing cost, and its distribution
node bench/claims.js window      # admission-window walks on the read path
node bench/claims.js latency     # PowerHistogram quantile accuracy across 4 decades
node bench/claims.js framedecode # incremental decoding against re-concatenating
node bench/claims.js hubencode   # whether the hub's fan-out flush is encode-bound
node bench/claims.js correlation # what awaiting a correlated reply costs
node bench/claims.js batchservo   # does a closed loop beat a fixed flush size
node bench/claims.js concurrency # is `autoScale.policy` wired to anything
node bench/claims.js stepsize    # does the autoscale step controller beat a fixed step
node bench/claims.js bcfanout    # one BroadcastChannel against K explicit MessagePorts
node bench/claims.js defer       # PowerDefer WeakMap overhead vs the closure form
node bench/claims.js codec       # JSON.stringify cost vs a minimal binary encoding
node bench/claims.js envelopepool # whether reusing an envelope pays on a message path
node bench/claims.js sabring     # SharedArrayBuffer ring vs structured clone
node bench/claims.js keyshape    # cache key-shape performance (int/string/object)
node bench/claims.js ratelimit   # static versus adaptive refill under burst + steady load
node bench/claims.js datagram    # bounded datagram queue saturation and flush
node bench/claims.js apdex       # APDEX from a sketch against exact counters
node bench/claims.js geoencode   # flat typed array vs object graph, four arms on one payload
node bench/claims.js geocoalesce # a coalescer against PowerBatch + a Map
node bench/claims.js geoprecision # what coordinate rounding actually saves, on two payload shapes
npm run bench                    # the full harness (over an hour)
npm run bench:baseline           # record this machine's regression baseline
npm run bench:gate               # check against it
```

That is **all twenty-eight** modes, not the six this file used to list: eleven
measurements were reachable only by reading `bench/claims.js`, and six of them
were named in neither this file nor `bench/README.md`. Seven more (`defer`,
`codec`, `envelopepool`, `sabring`, `keyshape`, `ratelimit`, `datagram`) landed
without this list being updated, which is the drift the paragraph below warns
about — so they are listed now rather than left for the next reader to discover.
Three more (`geoencode`, `geocoalesce`, `geoprecision`) landed the same way and
were caught by `npm run check:bench-list`, which is now step 12 of `verify` and
compares this list against the harness's own mode table.

The list above is still hand-maintained, so it is now **checked rather than
trusted**: `npm run check:bench-list` (step 12 of `verify`) runs the harness with
a nonsense mode, reads the mode list out of its own generated error, and fails if
this file disagrees in either direction — a mode that exists but is undocumented,
or one that is documented but no longer runs. It uses that error as its source of
truth rather than parsing `MODES` out of the source, because a regex over an
object literal stops matching the day someone reformats it, and a gate that
silently stops matching is the failure this project has already recorded several
times. If that list and this one disagree, this one is wrong — and now something
says so.

## Working rules, and where they came from

**Measure the premise before building the feature.** Four items in this project's
own history were scoped to a number nobody had produced. All four were wrong, in
both directions: a compression feature assumed a cost a `Worker` port does not
charge; a `SharedArrayBuffer` permit pool was called "the one change that could
move the pool's floor cost" and measured 6.4× _more_ expensive than the field
read already in the path; a streaming half was budgeted at 80 LOC and was a new
protocol. Each now has a `bench/claims.js` mode that settles the question
reproducibly. If a row asserts a performance benefit, running the measurement
_is_ the first task.

**Reproduce against the real call path, not a synthetic one.** The same error
four times: a TinyLFU window sweep run in a private harness disagreed with
`bench/claims.js` (58 % against its 75 %) and had to be discarded; a
`setImmediate` change was measured at 608× per turn and then found to be
**within noise end to end**, because `PowerChunker` posts chunks as a batch and
the timers all expire together. Per-turn cost is not batch cost.

**Mutation-check anything that claims to detect a problem.** A guard that has
never been observed failing is a hypothesis. The timing gate
(`bench/baseline.js`) passed a deliberate 64 % regression in `PowerCache.get`
twice: once because it had **no cache site to measure at all**, and once because
a units error turned a 60 % band into a 3000 % allowance. Both were found only by
injecting the fault. The same discipline caught an unreachable-coverage item that
was a real product bug.

**Write down the dispose rule, because the split is not self-evident: a helper
that owns a timer, a listener registry, or a `FinalizationRegistry` must implement
`dispose()` and `[Symbol.dispose]`; a lazy helper must implement it as a state
reset.** Twelve helpers had neither, and for a stateless value type
(`PowerDefer`, `PowerLogger`, `PowerBuffer`) that is obviously right — so the
absence reads as deliberate everywhere, including where it was not. The
clock-driven limiters were the real gap: `PowerThrottle`, `PowerSlidingWindow` and
`PowerGCRA` are the helpers a caller holds for the process lifetime, and without
`dispose()` they cannot take part in `using` / `await using` or a DI teardown,
which every other long-lived helper here supports.

The second half of the rule is the part that is easy to get wrong. None of those
three owns a timer — each refills lazily, computing elapsed time from a stored
timestamp whenever it is read. So their `dispose()` is a _state reset_, and
describing it as "cancels the interval" would document work that is not
happening. The interface is identical either way; the reason is not, and a
comment that blurs it is worse than no comment.

**A test that cannot fail on the regression it names is decoration — delete it,
do not loosen it.** A timing assertion that passed with the fix reverted was
removed rather than given a bigger threshold.

**A cross-realm type test needs an internal-slot check, not `instanceof` and not
`Symbol.toStringTag`.** Both of the obvious answers are wrong, and this project
has now walked into both. `instanceof` compares against _this realm's_
prototype, so it is `false` for a value from another `vm` context, an iframe, or
a `node:vm` sandbox — `errors.js`, `powerMessageCodec` and `powerBuffer` each
carried a site where that turned a caller's error into a substitute or, worse,
silently dropped a payload. `Object.prototype.toString.call(v) ===
'[object ArrayBuffer]'` **is** realm-independent, and it is also **spoofable**: a
plain `{ [Symbol.toStringTag]: 'ArrayBuffer', byteLength: 8 }` reports
`[object ArrayBuffer]` _and is accepted by `new Uint8Array()`_, so a `toString`
check converts an impostor into silent corruption rather than a rejection. What
ships is `Reflect.get(ArrayBuffer.prototype, 'byteLength', value)` — the spec's
own accessor, which performs the internal-slot check, returns the length for a
real buffer and **throws `TypeError`** for the impostor, cross-realm included.
`ArrayBuffer.isView()` is already realm-independent and is the right test for a
view. Two of the three defects above were in code that had _already_ been fixed
for this class, because `isView` covered views and the author read that as
covering the file. **When you fix one site of a defect class, grep for the class
and not for the site** — and prefer a test whose fixture is a real second realm
(`node:vm`), since a hand-rolled `{ byteLength: n }` stand-in is _accepted_ by
`new Uint8Array()` and would pass for the wrong reason.

**A guard that has never been observed failing is a hypothesis, and a guard that
prints `ok` while checking nothing is worse than one that is absent.** The first
version of `docs:claims` matched the JSDoc spelling of a typedef (`@typedef
{Object}`) when `types/` emits the compiled one (`export type X = {`), so it
found nothing to compare against and reported "no options typedef" for all ten
guides it existed to check — including the one whose stale row it was written
for. Two further rounds of mutation-checking _passed_ for the same reason: the
defect was present and the guard was not running. What finally exposed it was
noticing that a green guard is suspicious when a known defect is in the tree, and
re-injecting it. A pass from a new gate is a hypothesis until you have seen it
fail on a real defect. The same script's third failure mode was a regex where
replacing `\Z` with `$` satisfied eslint's `no-useless-escape` while breaking a
section match, because the pattern carried the `m` flag and `$` then matched every
line end. It is now `// eslint-disable-line` with the reason written down.

**A duplicated return type drifts the moment the original changes — delete the
copy, do not assert it stays in sync.** The `getStats()` alias first repeated each
`stats()` return shape by hand in nine JSDoc blocks. A concurrent change added
`staleServes` and `expirations` to `PowerCache.stats()` and the copies were stale
within the same session. A test caught it, which papered over the cause: nine
copies of nine shapes, each with a comment claiming an explicit type was safer.
It was not. Omitting `@returns` lets `tsc` infer a byte-identical published type,
which is what it does now — the copies are gone, so there is nothing to keep in
sync. The lesson is the shape of it, not the case: **if a type must be written
twice, expect it to be wrong once, and prefer deleting the second one over testing
it.**

That same test was then asserting _string_ equality between the two declarations,
which reported a false mismatch (`PowerRetryBudgetStats` versus
`import("./jsdoc-types.js").PowerRetryBudgetStats`) and pushed the hand-written
`@returns` back. Semantic equivalence is now asserted where it belongs, in
`test/types.test-d.ts`, by compiling bidirectional assignments — the property a
consumer relies on, rather than the spelling they happen to use.

**Behaviour versus coverage.** Lines 47–65 of `WorkerAgnostic.js` are uncollectable
under vitest (they need a real pure-ESM process, and `vi.stubGlobal('require')`
does not work because vitest injects `require` into the module _scope_). Their
behaviour is tested in a real subprocess instead. Do not conflate the two, and do
not add an assertion that would pass either way.

**Do not guess a shape.** Three test drafts in this project failed on a guessed
message payload, a guessed `drain()` return value, and a guessed
`detectEnv()` result — in the last case the test passed while exercising the
_other_ branch. Read the code.

**The plan table must be closed in the same commit as the work.** FEAT-008 read
⬜ for three commits while its work sat in the tree. A stale row is worse than a
missing one: it sends someone to build something twice.

**After an edit that lands next to a structural boundary, verify the pairing — no
gate here will.** Three defects in one session shared a shape: a doc comment
orphaned from its function by inserting a new function between them, a changeset
section header consumed as an edit anchor (three times, and the _third_ time
after the second had been repaired), and a table row left with seven columns
because a script's `split(' | ')`/`join(' | ')` round-trip double-added the
leading pipe and dropped the trailing one. **Lint, `docs:claims`, `docs:drift`,
`test/docsCodeAgreement`, the type ratchet and 2885 tests were all green through
every one of them.** None of these is a value error, so nothing type-related or
behavioural can see it; the failure lives entirely in the arrangement of text
around a boundary.

So the check has to be structural and explicit, and it is the same discipline as
the mutation checks:

- **A doc comment belongs to the function immediately below it.** After inserting a
  function above an existing one, confirm the `@param` still sits on the method it
  names — a duplicate JSDoc block is not an error to any tool, and typedoc simply
  attaches the first one it finds.
- **Never anchor a replacement on a neighbouring section header.** Anchor on a
  unique _body_ string instead. Or, if the header must be the anchor, assert that
  the text following the replacement is the expected next header and **abort
  rather than guess** — that assertion is what turned the third occurrence into
  one wasted step instead of a corrupted changeset, and it is worth writing
  before the edit rather than after the mistake.
- **Count the columns after rewriting a table row, both ends.** `review:check`
  catches the result, but only once the file is already written; verify against a
  backup that the diff is _one_ changed line, and remember that a `|` inside
  backticks — `a || b` — splits a cell just as a bare one does.

## Documentation

Three kinds, and they are not interchangeable:

| Location  | Kind                                           | Written by | Audience                     |
| --------- | ---------------------------------------------- | ---------- | ---------------------------- |
| `guides/` | Reference — what the API is and how to call it | humans     | someone using the library    |
| `docs/`   | Generated API reference                        | `typedoc`  | looking up a signature       |
| `adr/`    | Decision history — why, and what lost          | humans     | someone changing the library |

A decision goes in `adr/` with a status; a rejected decision is still worth
recording, because the next person should find the measurement that killed it.
Working notes do **not** get their own root directory — a `design/` folder existed
for one 32 KB note and was folded into
[ADR 0003](adr/0003-tinylfu-admission-window.md).

`guides/metaGuide.md` is the router: "I have this problem, what do I reach for."
When you add a helper, it belongs in its section _and_ in the quick chooser.
Before you finish, check for duplicated or contradictory sections — the file
carried two "Realtime: framing" sections, one of them a truncated copy of the
other.

## Tests

`test/` is flat, one file per concern, named after the unit under test
(`powerCache.tinylfu.test.js`, `powerPool.negotiation.test.js`). The naming
convention for follow-up coverage is `*.extra.test.js` / `*.branches.extra.test.js`.

Style that is deliberate here, not incidental:

- Comments explain **why a test exists**, usually with the defect it would catch.
  "This branch is awkward" is not a reason; "this is the one argument the guide
  shows and it is the second parameter, not the first" is.
- A test that pins a _loss_ is a characterisation, not an aspiration, and says so
  — the framed protocol losing a `Map` is pinned so that making the frame
  lossless is a deliberate decision rather than an accident.
- Prefer a counter or a shape over a duration. The harness measures a 28.61 %
  median min/max spread on a typical machine; anything finer is noise.
- `test/apiSurface.test.js` pins the exact export list. Adding an export means
  updating it, deliberately.
- Workers are faked as classes in-test. See `test/powerPool.protocol.test.js`
  and `test/powerPool.negotiation.test.js` for the two shapes.

## Things not to do

- Do not add a runtime dependency. This library ships with none, and that is a
  product decision (`REJ-008`).
- Do not add an `await` to a hot synchronous path to make something async.
  Several helpers are sync and documented as such.
- Do not "fix" a documented quirk that is a deliberate decision
  (`drop-oldest` bounding the queue at one entry; `hasEqual` not touching
  recency; prototype-strict comparison) without changing the documentation and
  the test that pins it in the same commit.
- Do not run `git commit` without a changeset unless the change is docs-only.
- Do not edit `types/` by hand. It is generated and `types:drift` will fail.
- **Do not use `git stash` to run an A/B comparison — copy the file instead.**
  Mutating a source file to see whether a test catches the difference is the
  standard move here, and `git stash push -- <path>` is the obvious way to undo
  it. It is also how you lose work on a dirty tree, because the pop re-applies
  the stashed state over anything that changed in between:
  - `git stash push -- src/` then `git stash pop` conflicted on
    `powerScheduler.js` and left nine conflict markers in a working tree, because
    the stash had captured a partial state. `HEAD` was clean, so the fix was
    `git checkout HEAD -- <file>`; had the commit been needed first, it would not
    have been.
  - The same round-trip a second time reproduced the conflict, on the same file,
    for the same reason.
    So: `cp src/foo.js /tmp/kilo/foo.bak`, mutate the real file, run the test,
    `cp /tmp/kilo/foo.bak src/foo.js`. It is faster, it cannot conflict, and it
    leaves the index alone. `git stash` is for parking work you intend to resume,
    not for a thirty-second experiment.
- **Do not trust a staged set you read before the commit — re-read it.** When two
  sessions share a working tree, `git add -- <explicit paths>` protects you from
  sweeping in _unstaged_ work, and it does not protect the commit at all. The
  index is shared. Four occurrences, the first two in one afternoon, none of them
  caught by `git status` or by staging carefully:
  - `ac45b6f` is titled `docs(review): BUG-003 is not a double-detach` and
    contains `types/helpers/powerServo.d.ts` and `docs/helpers/powerServo/**` —
    generated trees for a source file that was not in the repository. **A clean
    checkout of that commit fails `types:drift`**, because `tsc` cannot produce a
    declaration for a class that is not there. Found by regenerating types from
    `git archive HEAD` and noticing the file did not reappear.
  - `e476642` is titled `docs(review): PERF-005 confirmed and material` and
    contains the whole feature: 613 lines of source, 731 of tests, a guide, an
    ADR and a changeset. My `git commit` ran afterwards and reported
    `nothing to commit, working tree clean` — the feature was in someone else's
    commit and the message described unrelated audit work.
  - `.changeset/release-2-0-0.md` was swept into `f637752` (`fix(metrics): …`).
    A changeset is the one artefact whose _absence_ from a commit is invisible:
    the file is edited constantly, so a stray `git add` of it looks deliberate.
  - `38f8e1d` (`feat(cache): pin the TinyLFU seed …`) carries
    `test/types.optionsCoverage.test.js`, which no one staging it had edited. It
    swept in a one-file fix to a committed test that was sitting unstaged in the
    shared worktree. **This one happened with the guard already written**, so the
    lesson is not only "use the guard" — it is that **the guard is opt-in and
    nothing says so at commit time.** `git commit` is exactly as unguarded as it
    was before the guard existed unless the commit goes _through_ the guard, and
    a bypassed guard leaves no trace in `git status`, the commit message, or the
    output.
    The hazard is that a wrong commit looks like a right one: the content is
    exactly what you staged, and nothing in `git status` disagrees. **So use the
    guard rather than the habit** —

    ```bash
    git add -- <explicit paths>
    node scripts/commit-guard.mjs commit -m "..."   # snapshot, verify, commit, re-verify
    ```

    — which records the staged set, refuses to commit if the index moved between
    that snapshot and the commit, and then confirms the commit it produced contains
    exactly those paths and blob hashes. The digest is content-addressed, so
    another session re-staging _different content_ under a path you already staged
    is caught too; a path list would miss that. The snapshot lives under `.git/`,
    so it never appears in `git status` and is never committed.

    The habit it replaces — `git diff --cached --name-only` immediately before
    `git commit` — is what all four occurrences above ran, and all four shipped.
    A habit is not a safeguard. If you commit by hand, re-read that list
    immediately before, not minutes ago.

    And if a commit you did not write already carries your work, do
    not rewrite shared history to fix its message; say so, and let the release
    notes carry the record instead. The changeset is the artefact that survives a
    misleading commit, which is part of why it is mandatory.

  - `81fbe8d` (`refactor: ten dispose() methods now neutralise through one
helper`) carries `src/helpers/powerRTCChannel.js` — **783 lines**, an entire
    new helper — plus `powerRateLimit.js`, `jsdoc-types.js` and their generated
    types and docs, all belonging to a concurrent session's in-flight work. The
    cause was `git add -- src/helpers/`: **a directory, which is `git add -A`
    scoped to one folder.** This is the fifth occurrence, and the first one where
    the guard _passed_ — the staged set and the commit did match each other. The
    set was simply the wrong set, and content verification cannot see that.
  - **Never stage a directory on a shared tree.** Stage ten explicit paths, not
    the folder they happen to share. `commit-guard.mjs` now takes
    `--expect path,path`, which compares the index against a declaration of
    intent **before** the commit runs, so this class is refused rather than
    reported afterwards. Use it for any commit touching shared code.

- **Regenerate `types/` _and_ `docs/` before you stage, never after.** The
  pre-commit hook refreshes `types/` and the visible page for the file you
  changed, but **not** `docs/docs-typedoc.json` — the aggregated comment index,
  where every source line shift invalidates a line reference. So any JSDoc edit
  leaves it stale and `verify` fails at step 11 with the other ten green. Twice,
  both times mine.

- **Lint-staged reads the _staged_ copy, and names the wrong task when it
  fails.** An edit made after staging is invisible to the hook. And with several
  tasks configured, one failure kills its siblings, so the message names a task
  that was merely collateral: `Task killed: prettier --write` was really an
  `eslint` error four lines above it. **Run `npx lint-staged` directly to see
  the real error** — I blamed load average 15, waited for it to fall, retried,
  and was wrong twice before reading the actual output.

- **When the type ratchet goes red, get the per-file listing before deciding
  whose it is.** The ratchet summary prints a _total and a sample_, and the
  sample points at whichever file sorts first — which was `WorkerAgnostic.js`
  both times, so I attributed my own three errors to a concurrent session twice.
  `npm run typecheck` prints per file. **Check your own files first**, then
  theirs. When your own change is the cause, get the _new_ errors by running
  `tsc` against a pristine `git archive HEAD` and diffing per file — a total
  plus a sample cannot tell you which of yours are new, and the line numbers
  shift under you so the diff must be on **message text**, not positions.
  Raise the ceiling only for debt that was already there: `--raise --reason` is
  for a file that is itself known debt, never for debt a change just introduced.
- **Do not edit `review.md` with a multi-step script, and do not trust one that
  reported success.** It is 450 KB+, gitignored — so `git checkout` cannot undo a
  bad edit and no commit ever holds it — and a markdown table row cannot contain
  a newline. Three failures in one session, all mine, and the third cost ~150 KB
  that is unrecoverable:
  - A `String.replace` whose "region" ran to end-of-file collapsed everything
    after the edited row into four characters.
  - A note written to a temp file with hard line breaks was appended verbatim,
    splitting one table row across ~50 physical lines.
  - A repair reported `row 649 -> 4268 chars, file +3619 bytes` as success while
    the line on disk was still 649 characters, because the measurement and the
    write had diverged. Only reading the line directly caught it.
    So: `cp review.md /tmp/…` first, collapse any note to a single line with
    `' '.join(text.split())` before it goes anywhere near a row, edit by index
    arithmetic on one line rather than by pattern over the file, and verify by
    diffing the prefix and suffix against the backup — not by the script's own
    report. `test/reviewTable.test.js` checks **structure** (column count, header,
    duplicate ids) and cannot see a truncated cell, so a green run there is not
    evidence the file is intact.
- Do not put a bare `|` in a `review.md` cell. Escape it as `\|`. The same
  applies to a shell operator inside backticks — `a || b` splits a cell, and the
  table test reports a _column_ error for a _character_ mistake.
  - **A `split(' | ')` / `join(' | ')` round-trip is not round-trip safe.**
    Splitting `| a | b |` leaves `| a` in the first element, so re-joining
    and re-adding a leading pipe gives `|| a | b |`; set the last element
    and the trailing pipe goes with it, leaving a seven-column row that
    `review:check` catches only after the file is written. Build the row as
    one string from cells you construct, and assert both ends of the line.

## Before you finish

```bash
npm run verify
```

Then: a changeset in `.changeset/`, guides updated if behaviour or a documented
decision changed, an ADR if a decision was made, and the review row closed in the
same commit as the work.
