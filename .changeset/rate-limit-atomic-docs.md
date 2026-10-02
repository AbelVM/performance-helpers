---
'performance-helpers': patch
---

**Documents how `PowerRateLimit`'s `atomic: true` actually achieves atomicity**,
and pins the invariant it rests on.

`atomic: true` is reached by **two different mechanisms**, and the option's
documentation named neither:

- A limiter exposing `available()` is settled by a pre-flight that asks every leg
  whether it can afford the request and charges nothing if any says no. **No
  rollback is needed or performed.**
- A limiter without `available()` cannot be pre-flighted, so it is composed
  through `reserve` with a best-effort rollback of the legs already committed.

All three limiters this library ships have `available()`, so the rollback path
serves third-party limiters — `p-limit`-shaped ones in particular.

The rollback path reads as _the_ implementation of `atomic`, and measuring it says
otherwise: with two `PowerThrottle` legs and the second drained, `atomic: true`
refused and **the first leg still held all 5 tokens**. Nothing was charged.

**The pre-flight and the commit that follows it are one synchronous block**, and
that is what makes the pre-flight sufficient on a single-threaded event loop:
nothing can interleave between "every leg can afford it" and "every leg has taken
it". Insert an `await` between them and `atomic: true` quietly becomes
best-effort for every limiter this library ships — a regression no behavioural
test would catch, since the interleaving it permits cannot be simulated without
destroying the property being asserted.

That invariant is now pinned, in `test/powerRateLimit.atomic.test.js`, by reading
the source. 7 tests, 4 mutants caught: dropping the `available()` check, removing
the refusal when no rollback is possible, making `_undoCommit` a no-op, and
making the method `async` with an `await` in the gap.

No behaviour changes. An internal review row had proposed routing `atomic: true`
through the rollback path or deleting it; measurement showed the first would add
a reserve/rollback round trip to every call in order to lose a guarantee already
held, and the second would remove real functionality for third-party limiters.
