---
'performance-helpers': minor
---

Implement `HyperLogLog` and the `PowerRateLimit.builder()` fluent API, closing two audit rows:

- **ALG-005** — `src/utils/hyperLogLog.js` ships a 64-register HyperLogLog
  cardinality estimator (~13 % standard error, 64 bytes) wired into
  `SmallLfuSketch.reset()` so the admission filter's half-life `sampleSize`
  adapts to the working set rather than staying at the default 10. Two bugs
  were found in the first draft of this file and are recorded in its header:
  `addHash` did not finalise its input, so sequential integers 0..N all had
  `h >>> 6 === 0` and every register saturated at rank 27, reporting a
  cardinality of 5.7 billion for a 100-element set; and the small-range
  correction used `zeros * ln(m / Z)` instead of the linear-counting
  `m * ln(m / Z)`. Both are fixed, and the fix is mutation-checked.
- **DX-002** — `PowerRateLimit.builder()` returns a `PowerRateLimitBuilder`
  with fluent `add()`, `atomic()`, `keyFn()` and `buckets()` methods, so a
  composed limiter reads `PowerRateLimit.builder().add(t).add(w).build()`.
  A factory function may be passed to `add()` in place of an instance, and
  an empty builder builds a permissive limiter.

No breaking behaviour changes.
