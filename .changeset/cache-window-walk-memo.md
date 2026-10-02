---
'performance-helpers': patch
---

**A main-space `get()` on a `PowerCache` no longer walks the admission window.**

`_windowOldest()` walked back from the tail while nodes were flagged, which is
O(windowSize) and runs on every main-space read — because `_moveToTail` on a
main-space node has to re-establish where the window starts. Measured with
`node bench/claims.js window`, 3000 entries resident:

| windowSize | before          | after          |
| ---------- | --------------- | -------------- |
| 0          | 74 ns/get       | 78 ns/get      |
| 100        | 306 ns/get      | 312 ns/get     |
| 1000       | **2177 ns/get** | **253 ns/get** |

**8.6× at `windowSize: 1000`, and flat across window sizes** where the cost
previously grew linearly. The bench's own ratio drops from **29.2× to 2.5×** per
`get()`, and window walks per main-space read go from 0.80 to **0.00**. That
matters because `windowSize: null` — the _documented recommended_ default at
`ceil(maxEntries * 0.01)` — is the large-window corner.

The walk is memoised, and the memo is **validated on every read rather than
maintained**. This is deliberately not the maintained pointer an earlier attempt
used and reverted: a pointer must be _corrected_ by every mutation, and it failed
by producing a confidently wrong answer, because a node with a correct `inWindow`
flag can still sit on the wrong side of the boundary. Here the memo can only be
trusted or discarded, never adjusted, so a mistake about some mutation costs one
walk rather than a wrong result. Invalidation lives in `_remove`, the single
funnel every unlink passes through, because `_moveToTail` unlinks through
`_remove` directly and a memo that is "usually" invalidated is the maintained
pointer this design exists to avoid.

A `get()` that lands _inside_ the window still walks, and correctly so: it
re-appends at the tail, which genuinely invalidates the memo.

Three conditions were mutation-checked, and two of them were not load-bearing when
first written — one was a wrong `memo === this._tail` check that made the memo miss
on every read (the walk runs _backwards_, so the window's oldest node is the tail
only for a single-entry window), and one was redundant with `_remove`'s
invalidation and has been deleted rather than kept as a check that cannot fail.
The remaining two are each shown to fail when removed.
