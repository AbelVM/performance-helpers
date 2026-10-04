# 0009. Which clock a helper subtracts

**Status:** Accepted
**Affects:** `PowerGCRA`, `PowerThrottle`, `PowerSlidingWindow`, `PowerCircuit`, `PowerCron`, `nowMs`, `monoMs`, RES-019

## Context

`nowMs()` reads **two** clocks per call. It prefers
`performance.timeOrigin + performance.now()` (or `process.hrtime.bigint()` plus a
module-load epoch offset) and cross-checks it against `Date.now()`, returning the
wall clock if the two have diverged by more than a second.

The cross-check exists for a real reason: under a test harness that fakes
`Date.now()`, it is what lets the helper follow the fake. `PowerCron.nextRunAt`
depends on that behaviour, because it is documented as epoch milliseconds and a
caller can hand it to a scheduler.

But the same guard means the reading **is the wall clock** whenever the two
diverge — and an NTP adjustment of more than a second is exactly that. A helper
that only ever _subtracts_ two readings inherits the wall clock's ability to
jump, and a jump forward becomes elapsed time.

Measured, with **zero** real milliseconds elapsed and only the wall clock moved:

| Helper                                               | Before                                            |                                                     |
| ---------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `PowerGCRA({rate:10, per:1000, burst:1})`, saturated | `available()` 0 -> 2, and `tryConsume()` admitted | `2` is `_ceiling()`, so the whole burst was granted |
| `PowerCircuit({threshold:1, timeout:60000})`, open   | `half-open` after a +60 s step                    | a dependency failing for 1 ms was offered a trial   |

## The claim that was wrong

The row that motivated this work stated that "a backward step makes `PowerGCRA`
grant a **full burst**". That is backwards, and it is worth recording because the
intuitive version is the one people will reach for.

A **backward** step was always harmless to these helpers:

- `PowerGCRA._tatAt()` clamps with `Math.max(now, this._tat)`, so an earlier
  reading keeps meaning "the TAT is ahead of us" — more restrictive, not less.
- `PowerCircuit` compares `nowMs() - _openedAt < _openWindowMs`, so an earlier
  reading keeps meaning "not much time has passed".

It is a **forward** step that hands out budget nobody spent. Measured both ways;
the backward case changed nothing observable. The consequence is not cosmetic: a
limiter that refills to capacity because the clock jumped has stopped bounding
load, and a breaker that half-opens on a clock step retries a dependency it was
supposed to be backing off from.

## Decision

Two clocks, and the split is by **what the caller does with the number**, not by
preference.

- **`nowMs()`** — unchanged, and cross-checks against `Date.now()`. For anything
  a caller reads as an _instant_: `PowerCron.nextRunAt`, a log line, an HTTP
  `Retry-After`.
- **`monoMs()`** — new. Same ladder, same sources, same epoch mapping, and one
  difference: `Date.now()` is never read. For **delta arithmetic**: `PowerGCRA`,
  `PowerThrottle`, `PowerSlidingWindow`, `PowerCircuit`.

Both remain epoch timestamps. `monoMs()` anchors the monotonic source to an
offset captured once at module load, so `stats().tat` and `tryReserve().runAt`
stay the instants they are documented to be. That is what made a relative
`performance.now()` the wrong fix: it would have been monotonic, and it would
have turned both of those into "milliseconds since page load".

The ladder is written once, in `_clockReading(wallDateNow)`, with the argument
carrying the policy. Two near-identical clock functions is the shape that has
produced four separate regressions in this project (`POOL-004`, `CACHE-004`, and
the two copies of `abortError` in `F-60`).

## Why not a last-value floor

A monotonic wrapper that clamps to its own previous reading looks like the
stronger guarantee, and it is the weaker one. It prevents the value going
_backwards_ while still permitting the forward jumps that are the actual defect,
so it would cost a branch on the hot path and a module-level mutable to fix the
wrong direction. The guarantee here comes from the _sources_: `performance.now()`
and `process.hrtime.bigint()` are monotonic by specification, and both epoch
offsets are fixed for the module's lifetime.

## What it costs

Faking `Date.now()` no longer drives a limiter's clock. For the three rate
limiters the supported route always existed and still wins over everything: the
`now` constructor option, or the per-call `{ now }` for a composition. For
`PowerCircuit` there was never a documented way in and there is not one now —
its window is measured from the real monotonic clock.

This is a behaviour change for anyone who was relying on the accidental route,
so it is called out in `guides/now.md`, in the four limiter guides' _Which
clock_ sections, and in `guides/powerCircuit.md`.

## Note on the implementation

The first version hoisted the fallback to the top of the shared resolver:

```js
const fallback = wallDateNow === undefined ? Date.now() : wallDateNow;
```

which meant `monoMs()` read `Date.now()` on **every** call — the exact cost the
function exists to remove, making the "one clock read" claim false while the code
looked correct. The test written for that claim caught it
(`expected "now" to not be called at all, but actually been called 3 times`), and
the fallback is now computed at each return site instead. Recorded because the
defect was invisible to every other test in the suite and to the type checker.

## Consequences

- One clock read instead of two on the limiter and breaker hot paths, and the
  "halves the clock reads" half of the row is real rather than aspirational.
- A wall-clock adjustment can no longer grant rate-limit budget or trip a
  breaker's open window.
- `monoMs` is a public export, so a caller writing their own limiter can use the
  same clock rather than re-deriving the decision.
- The split has to be _stated_, because it is not self-evident: the interface is
  identical and the reason is not. Every guide that documents a default clock now
  names which one and why.
