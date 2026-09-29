---
'performance-helpers': patch
---

De-flakes the two test files with the most fixed sleeps, and fixes a
`review.md` structural problem.

**`test/powerPool.test.js`** — 9 fixed sleeps → `vi.waitFor`, 0 remaining.
**`test/powerScheduler.yield.test.js`** — 7 → 4.

`vi.useFakeTimers()` is the wrong tool for most of these. `vi.waitFor` is
correct for "wait until X happened": it polls the condition and returns the
moment it holds, where a fixed sleep guesses in both directions. Fake timers
are correct only for "assert nothing fires within N ms".

The 4 that remain in the yield file are not convertible, and the reason is
specific: `scheduler.yield()` returns a promise with **no handle to detach**,
so there is nothing for `advanceTimersByTime` to reach. Those tests assert the
flush _never_ runs, which `vi.waitFor` cannot express — its condition is
already true before it starts, so it would pass **vacuously**. The file header
now says so, to stop the conversion being made and the evidence deleted.

Suite-wide fixed waits: 62 → 52.

**`examples/observability.mjs` was flaky** — it blocked the event loop for
40 ms and asserted the monitor saw a 35 ms stall, failing about one run in five.
A 5 ms sampler can only observe the gap between two of its own ticks, so it
under-reports. Now blocks for 100 ms and asserts 40. `test/examples.test.js`,
the CI check added in 2.0.0, caught it.

**`review.md`**: seven rows had a notes column split by a literal `|`, which
silently drops a column while the row still renders. `test/reviewTable.test.js`
now checks the column count and the trailing pipe, with teeth verified by
deliberately adding one. A second, unfixed problem is recorded in the file
itself: the rows disagree with the table's own header about what a column
holds, which needs a human pass rather than a script.
