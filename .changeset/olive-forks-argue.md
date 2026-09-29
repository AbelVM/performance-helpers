---
'performance-helpers': patch
---

Adds a performance-regression guard that is not a timing gate.

The plan called for a ±20 % wall-clock check on `PowerCache.get` and
`PowerThrottle.tryConsume`. That is not implementable here, and the reason is
measured: BENCH-001 recorded a **28.71 % median min/max spread** across 22
timed variants (p95 113 %) on this machine. A ±20 % gate against that fails on
a clean tree and passes on a real regression about as often as not, and a gate
that cries wolf gets deleted after its first false alarm. More repeats do not
help — the spread is dominated by sub-millisecond variants, where timer
resolution is a large fraction of the measurement.

`test/invariants.test.js` therefore guards the thing the item was aimed at —
accidental _algorithmic_ regressions — using the library's own operation
counters, which are integers and do not move with machine speed:

- `PowerCache` reads are pure: a miss evicts nothing, a set on a full cache
  evicts exactly one, a cap is exact, and the evictions account for the
  difference. An oversized value is rejected _without_ evicting on its behalf.
- `PowerThrottle` admits exactly `capacity`, and refills proportionally with a
  fractional carry rather than crediting whole intervals.
- `PowerGCRA` admits `burst + 1` — `burst` is additional tolerance, not a
  total.
- `PowerBatch` splits on exactly `maxSize`, delivers every item exactly once,
  and preserves order within and across batches.
- `PowerQueue` preserves FIFO under interleaved push and shift, and grows by
  doubling.
- `PowerPool` holds its queue cap, accepts exactly `maxQueueLength` under the
  `enqueue` policy, and its task accounting returns to zero.

Verified to have teeth by mutating the source twice: replacing
`newCap = oldCap << 1` with `oldCap + 2` fails the growth progression, and
making a cache miss bump `_evictions` fails both read-purity tests.

**What this does not catch: a constant-factor slowdown.** If `cache.get` became
30 % slower per call, every assertion here still passes. That needs a timing
gate with a per-machine baseline and a threshold set from a measured p95, which
is the remaining part of the item.

Tests only. No behaviour change.
