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
```

The gate is `scripts/verify.mjs`, and it is the **only** list of checks — ten
steps. CI calls it rather than keeping its own copy: it did once, and the copies
drifted until CI was running neither `test:types` nor `check:bundle` (see the
comment at the top of `.github/workflows/ci.yml`). **To add a check, add it to
that script**, not to the workflow.

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
npm run bench                    # the full harness (over an hour)
npm run bench:baseline           # record this machine's regression baseline
npm run bench:gate               # check against it
```

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

## Before you finish

```bash
npm run verify
```

Then: a changeset in `.changeset/`, guides updated if behaviour or a documented
decision changed, an ADR if a decision was made, and the review row closed in the
same commit as the work.
