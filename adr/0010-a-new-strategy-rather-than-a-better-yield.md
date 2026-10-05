# 0010. A new `postTask` strategy, rather than a better `yield`

**Status:** Accepted
**Affects:** `PowerScheduler` (`src/helpers/powerScheduler.js`) — the `scheduling` option's value set, the new `taskPriority` option, and `_abortTask()`
**Evidence:** `test/powerScheduler.postTask.test.js` (15 tests), `test/powerScheduler.yieldGeneration.test.js`, and 12 injected mutants of the new path, every one killed by a named test. The Scheduling API (`scheduler.postTask`, `TaskController`). No benchmark: this is an API-shape decision, not a performance claim — see _Not measured_ below.

## Context

GAP-013 asked for `scheduler.postTask(fn, { priority, signal })` plus
`TaskController`. The row's own note is the observation that decided the shape:

> MDN confirms a `TaskController` **can cancel a `scheduler.yield()`
> continuation** — so the platform does natively what F-54 hand-rolls a
> generation counter for, and adds priority on top.

That is a genuinely better primitive than the one the `yield` strategy uses.
`scheduler.yield()` returns a promise and **no handle**: the continuation is
queued the moment it is requested, so it cannot be detached, and this library
resolves that by comparing a generation counter on resumption (RES-006, after
F-54/RES-005 first shipped the strategy without one and RES-006 proved the
counter load-bearing).

Two facts about `postTask` decide this ADR:

1. **It is a fourth strategy, not a replacement.** The three existing strategies
   are `microtask`, `macrotask` and `yield`, and `scheduling` is a closed set
   that throws on an unrecognised value — deliberately, because it used to be
   `=== 'macrotask' ? 'macrotask' : 'microtask'`, so a typo silently selected
   the fastest strategy.
2. **It is only available in some runtimes.** Chromium-family browsers and, as of
   2026, Firefox. Node does not have it. So the row already specified a fallback.

## Decision

**Add `scheduling: 'postTask'` as an opt-in fourth value.** Do not route `yield`
through `postTask` where it happens to exist.

`postTask` needs **both** `scheduler.postTask` and `TaskController` to be
present. It needs the priority and the signal passed through, and the live
controller kept so `flush()`, `cancel()` and `dispose()` can abort the queued
task. Where either half is missing, `strategy.supported` is `false` and the
strategy falls back to a **macrotask**.

## The alternatives, and what killed them

### Route `yield` through `postTask` where it exists — rejected

This is the one a reasonable reviewer would prefer, and it is worse. It changes
the behaviour of every caller already on `scheduling: 'yield'` — in an upgrade,
with no change to their code — for a scheduling difference they did not ask for.
It also produces a class of bug this library has already been bitten by twice: a
substitution that is invisible at the call site and in `strategy.supported`, so
the ordering a caller gets depends on which runtime they happen to run.

Concretely, it would leave the yield path needing a generation counter in exactly
the runtimes where `postTask` is absent and not needing it where it is present —
so the same strategy would carry two different cancellation mechanisms, chosen by
feature detection, with nothing reporting which one is live.

The asymmetry is the argument: **a new name is visible** in a stack trace, in
`strategy.supported`, and in the options object. A substitution is none of those.

### Use `postTask` alone, without requiring `TaskController` — rejected

`postTask` returns a handle with **no `cancel` method**. A strategy built on it
alone would be _less_ cancellable than the `MessageChannel` macrotask it
replaces: `flush()` and `cancel()` would have to fake it with a generation
counter or a flag check, arriving back at the machinery this row was opened to
remove. And the feature test that would let it through is the obvious one —
`typeof scheduler.postTask === 'function'` — which passes an implementation that
has quietly lost cancellation.

The symmetric half matters too: `TaskController` alone gives nothing, since
without `postTask` there is no task to attach a signal to. Both are required and
each is tested alone.

### Fall back to `queueMicrotask` where `postTask` is missing — rejected

It would satisfy "the flush still happens", and it is a different **ordering**.
The unsupported branch falls back to a macrotask for the same reason `yield`'s
does: a scheduler's promise is that a scheduled flush happens _promptly_, and
falling back to the strategy we already offer would make `postTask` less
predictable than `macrotask` on exactly the runtimes that lack it.

The first version of that test only asserted "it still flushes", and a microtask
fallback passed it. It now asserts the flush has **not** run after a microtask
checkpoint, which is the only thing that distinguishes the two.

## One mechanism per job, and how the first version got that wrong

The first implementation made `_timer` a wrapper — `{ cancel: () =>
this._abortTask() }` — on the reasoning that `_timer` is the shared teardown
shape, so a `postTask` handle should fit it. It also called `_abortTask()`
explicitly from `flush()` and `cancel()`.

That made the abort reachable by **two independent routes**. Injecting mutants
found it: deleting either one left the other intact, and every test stayed green.
Four of the first ten mutants survived, all in the abort path.

This is the shape AGENTS.md warns about under _a duplicated type drifts the
moment the original changes_ — one mechanism written twice, where neither copy
can be observed missing. The fix was to delete the wrapper, not to add a test:
`_timer` is now an honest `{ cancel: () => {} }` placeholder on this strategy,
exactly as the `yield` path's already is, and the explicit `_abortTask()` at the
teardown sites is the single mechanism. After that, 12 of 12 mutants are killed
by a named test — including _no abort in `flush()`_, _no abort in `cancel()`_,
_`dispose()` no longer cancels_, and _`_abortTask` does not abort_.

`dispose()` reaches the abort **through** `cancel()`; there is no third call
site, and that is recorded in the `_abortTask()` doc comment because an auditor
grepping for it will find two calls and may reasonably conclude teardown misses
it.

## Not measured

**No benchmark.** The row makes no performance claim — it is about API shape and
cancellability, and the case for `postTask` is a browser priority the library
cannot reproduce in Node. A benchmark here would measure the fake, not the
platform, which is the same synthetic-harness mistake
`bench/claims.js` already exists to correct.

What _is_ asserted is behavioural: the abort happens before the flush on
`flush()`, the queued task is never run after `cancel()` or `dispose()`, and the
`yield` path is untouched by any of it.

## Consequences

- `scheduling` gains a fourth value; the closed set and its `TypeError` are
  unchanged, and `'postTask'` is in `assertKnownOptions`' accepted list.
- `taskPriority` is new. Following `PowerCache`'s `filter` option, the value is
  **validated on every strategy** while a valid one on a strategy with no use for
  it is accepted and inert — a caller forwarding a shared options object is not
  broken by it.
- `PowerScheduler` needs no generation counter on `postTask`, and still needs one
  on `yield`. Both facts are asserted, not just documented: `test/powerScheduler.postTask.test.js`
  asserts `_generation` is unchanged across `schedule()` and the flush, and
  `test/powerScheduler.yieldGeneration.test.js` guards the counter it does need.
- The guide's `yield` section claimed the counter was an equivalent mutant and
  had been deleted. It is retained here as a retracted claim rather than removed:
  the source comment and `guides/powerScheduler.md` now both carry it, so the next
  reader who re-derives it finds it already answered.
