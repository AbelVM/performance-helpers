---
'performance-helpers': patch
---

### Fixed

**`PowerRateLimit.reserve()` reported every reservation as granted when
`sharedState` was configured with an async adapter.**

The implementation was `if (!this.tryConsume(...)) return null;` — and `tryConsume`
returns a _promise_ for an async adapter. A promise is truthy, so `!promise` was
`false`, the guard never fired, and the method returned `{ n }` unconditionally,
including for reservations the shared store had denied. A caller who then
`release()`d that token credited permits that were never spent, so the distributed
budget leaked by one per denied request.

Reproduced before the fix: an adapter denying everything, `reserve(1)` returning
`{ n: 1 }` where the synchronous adapter correctly returned `null`.

### Added

`PowerRateLimit.reserveAsync(n, options)` — the awaiting counterpart to `reserve()`,
for an async `sharedState` adapter. Same contract, same `{ n }` token shape, same
`null` on refusal.

`reserve()` now **throws** a `TypeError` when the adapter is async, rather than
returning `null`. That is deliberate: returning `null` would tell a caller "you were
denied" when the truth is "I could not find out", and those need different handling.
A synchronous method that cannot be synchronous says so.

`reserveAsync()` covers both shapes — `tryConsume` normalises them and `await` on a
boolean is that boolean — so a caller with a synchronous adapter can use either
method, and `reserve()` is the cheaper one there because it allocates no promise.

### Known limitation

**The shared store has no refund.** Its contract is `checkAndIncrement(key, n)` and
nothing else, so `release(token)` credits the _local_ legs and cannot decrement the
distributed counter. A reservation that is released therefore still counts against
the global budget for the window. That is a limitation of the adapter contract
rather than an oversight, and closing it needs an atomic decrement in the store —
a design question, not a bug fix. Recorded in the guide rather than left for a
caller to discover.

### Tests

9 new tests in `test/powerRateLimit.sharedState.test.js`, mutation-checked 3 of 3 —
including restoring the original defect, which is the mutation that matters.

The defect is pinned as a characterisation of what the old code did, not only as an
assertion of the fix, because the point of the row is that the failure was _silent_:
a test that only asserts the corrected behaviour cannot show what it corrected.
