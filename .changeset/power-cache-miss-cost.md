---
'performance-helpers': minor
---

### Added

- `PowerCache`'s `missCost` option, and the `missCostScan` width that bounds it.
  Every eviction policy this library ships answers _how often_ an entry is used;
  none answers _what a miss costs_. For a cache in front of an expensive
  computation those are different questions, and no recency- or frequency-based
  policy can see the difference.

  When the hook is set, the LRU eviction path evicts the **cheapest of the next
  `missCostScan` candidates** instead of the head. The hook receives both the key
  and the value. With no hook set the path is byte-for-byte the old one — one
  node read, one unlink, no scan.

  The measurement that sets the default, on a two-class workload (2000 cheap keys
  at 1 ms, 400 dear keys at 100 ms, a 500-entry cache, 10 % dear accesses):

  | `missCostScan` | dear keys re-read | dear keys one-off |
  | -------------: | ----------------: | ----------------: |
  |              1 |          baseline |          baseline |
  |              8 |        **−1.8 %** |            +0.0 % |
  |             32 |        **−7.3 %** |            +0.1 % |
  |            500 |       **−84.2 %** |        **+1.7 %** |

  The last row is the reason the default is 8 rather than something impressive. A
  full scan is dramatically better when expensive keys are re-read and measurably
  **worse** when they are not — it fills the cache with entries that will never be
  read again and evicts cheap ones that will be. The benefit is entirely a
  property of the caller's workload, which is why the hook is opt-in and the width
  is a knob. Both rows are asserted in `test/powerCache.missCost.test.js` as
  characterisations, including the adversarial penalty, so "the hook is free"
  cannot be claimed by reading only the beneficial row.

  Eviction becomes O(`missCostScan`) instead of O(1) when the hook is set. The
  walk is bounded and the bound is the design: an unbounded scan would be O(n) on
  the path that runs every time the cache is full.

  A throwing hook is treated as "no opinion" and falls back to recency for that
  candidate, for the same reason `onEvict` is guarded — the eviction path has no
  `try/catch` above it, so a callback error would otherwise turn a cache write
  into a crash. A non-number return is also "no opinion": `NaN` loses every
  comparison, so a candidate whose cost could not be read never wins.

  Mutation-checked 9 of 9 reverts killed by a named test. One of those nine
  established something worth recording: the `this.missCost ?` guard on the
  eviction path is a **performance** guard, not a correctness one. Removing it is
  behaviourally equivalent, because `_cheapestEvictionCandidate` still returns the
  eviction candidate when every cost reads as `NaN`. What changes is that the
  common path would call a `null` hook once per candidate per eviction and catch
  the resulting TypeError. The test that pins it spies on the method rather than
  measuring a duration, per the house rule.
