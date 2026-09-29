---
'performance-helpers': patch
---

Acts on three deferred items, and records a measurement that did not survive.

**DEFER-002 — `PowerChunker` no longer defers chunks through a timer.**
`PowerChunking` is not a fallback path; it builds inline workers in every
environment, so the scheduler behind it runs on every batch. It still yields —
`setImmediate` is a macrotask, and a microtask would starve the event loop, which
is why the item was deferred in the first place. It drains FIFO, so chunk order
is preserved.

Node clamps a zero timer delay to 1 ms, which makes the choice look enormous in
isolation: `setTimeout(fn, 0)` costs 1057 µs per turn against `setImmediate`'s
1.74 µs. **That 608× does not survive contact with the real workload.**
`PowerChunker` posts every chunk as a batch, so the timers all expire together
and fire in one pass — the 1 ms floor is paid once per batch, not once per
chunk. End to end, 2000 items, median of three:

| `poolSize` | `setTimeout(fn, 0)` | `setImmediate(fn)` |
| ---------: | ------------------: | -----------------: |
|          1 |              1.5 ms |             0.8 ms |
|          4 |              0.8 ms |             0.9 ms |
|          8 |              0.7 ms |             0.8 ms |

Within noise. The change is kept for intent rather than speed: `setImmediate` is
the primitive that means "run this soon without waiting for a timer", and it drops
a Node timer dependency. **A timing assertion was written for it, passed, and was
deleted rather than loosened — because it also passed with the fix reverted.** A
timing test that cannot fail on the regression it names is decoration. The four
tests that remain pin what a faster scheduler is most likely to lose: the work is
deferred rather than synchronous, every item is processed once, order is
preserved, and `drain()`'s summary is unchanged.

**DEFER-003 — `hasEqual`'s prototype strictness is now documented.** A class
instance and a plain object with identical own properties compare `false`; two
instances of the same class compare `true`. Verified before writing it down.
`guides/powerCache.md` now shows the case with a worked example, says why it is
deliberate, and points at `compareFn`. The decision is unchanged — only the
documentation that was missing.

**DEFER-004 — `hasEqual` is now documented as not counting as a use.** The row
recorded the decision as "documented"; the _behaviour_ was not, which is what a
user meets. A scan of `hasEqual` calls evicts a working set under a small cache,
and the guide never said so. It now does, alongside `peek`, with the reason: an
equality check is usually not "recent use", and treating it as one would let a
lookup pattern reshape the eviction order.

**DEAD-003 is closed as will-not-do.** `docs/` must be tracked — the project
website links into it — so untracking it would take the site down with nothing to
replace it. A previous session reached the same conclusion by doing it and
reverting. The 1.7 MB of generated typedoc is the price of a working
documentation site, and any future proposal should carry the replacement host and
pipeline before it touches `.gitignore`.
