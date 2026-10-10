---
'performance-helpers': minor
---

### Added

- `PowerApdex` — APDEX scoring over three integer counters. `record(ms)` classifies
  each completed request as satisfied, tolerating or frustrated against a required
  `target` and an optional `tolerance` (default `4 * target`, the APDEX
  convention), and `score()` returns `(satisfied + tolerating / 2) / total`, or
  `undefined` before anything is recorded. `merge()` is exact, so per-worker
  scorers aggregate; `dispose()` is a state reset, since the helper owns no timer.
  `record(Infinity)` files a request that never completed as frustrated.
- `PowerHistogram.countAtOrBelow(value)` — the inverse of `percentile()`: the
  estimated number of samples **at or below** a value, in O(log b) over occupied
  buckets. This is the rank query the sketch was missing, and it answers "what
  fraction of my requests were under X" directly.

### Changed

- `PowerHistogram`'s cached bucket order now carries cumulative counts alongside
  the sorted index list, so `countAtOrBelow()` does not walk the occupied range.
  One cache rather than two, invalidated at the same four sites.

### Not derived, and why

`PowerApdex` does **not** compute its score from a `PowerHistogram`, although
that would have been less code and no new state. `bench/claims.js apdex`
(BENCH-002m) measures the derived version: within 0.057 APDEX points of exact on
a lognormal, bimodal or pareto distribution, and **324 points wrong** — reporting
0.625 for a service attaining 0.950 — when the mass concentrates inside one
bucket straddling the threshold. The error is not monotonic in
`relativeAccuracy`, so there is no accuracy setting that repairs it, and a service
operating at its own SLO boundary is exactly that distribution. The exact path is
also a seventeenth of the per-sample cost and `O(1)` in memory. See
`adr/0014-apdex-counters-not-a-sketch.md`.

`countAtOrBelow()` ships as a general rank query and is documented as unsound for
an SLO attainment figure, with the number, in both its JSDoc and
`guides/powerHistogram.md`.

### Documented, deliberately not built

`guides/powerApdex.md` and `guides/metaGuide.md` carry recipes for pairing
`PowerApdex` with `PowerBrownout`, windowing it with a double buffer, and scoring
per route — and a section on why it must **not** be used as an adaptive control
signal. Every adaptive helper in this library takes a signed, unbounded,
gradient-carrying quantity (`PowerServo`, `PowerFlowControl`,
`PowerAdaptiveProposal.propose(signal)`, the pool's EWMA-latency autoscale);
APDEX is a bounded ratio that saturates at `1.0` and goes blind exactly when the
SLO is being met. No meta helper was added, because the one sound composition is
three lines of caller code. See
`adr/0014-apdex-counters-not-a-sketch.md`.
