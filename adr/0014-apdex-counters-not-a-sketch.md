# 0014. APDEX keeps integer counters, not a score derived from a sketch

**Status:** Accepted
**Affects:** `PowerApdex` (`src/helpers/powerApdex.js`) — new; and `PowerHistogram.countAtOrBelow()` (`src/helpers/powerHistogram.js`) — new, but deliberately _not_ the basis of the score
**Evidence:** `node bench/claims.js apdex`, run 2026-10-09. The mode was added for this decision; before it existed the question had no answer either way.

## Context

APDEX was requested as either a new helper or an addition to the observability
set. The formula is three lines, so the interesting question was never whether it
could be built — it was **what it should be built on**.

The obvious answer was "nothing new". `PowerHistogram` already answers
`percentile(q)`, a value at a rank. APDEX needs the inverse, a rank at a value,
and that inverse is a small, well-specified addition to the same class. So
`apdex(histogram)` would be two rank queries and a division, with no new state,
no new `stats()` shape, and no second source of truth — which is the property
`src/helpers/metrics.js` exists to protect.

That reading is correct about the mechanics and wrong about the guarantee, and
the difference is the whole of this ADR.

## Measurement

DDSketch bounds the **value** of a quantile to a relative error of `alpha`.
BENCH-002b measures exactly that and it holds. It says nothing about the **rank**
of a given value, and APDEX is a ratio of ranks taken at a threshold. Every
sample in the bucket the threshold lands in is split by linear interpolation in
log space — correct when the mass is spread across that bucket, arbitrary when it
is not.

`bench/claims.js apdex` scores exact three-counter APDEX against the derived
score, 100,000 samples, target 100 ms, tolerance 400 ms:

| `alpha` | distribution                   |  exact | sketch | delta (points) |
| ------: | ------------------------------ | -----: | -----: | -------------: |
|    0.05 | lognormal, median at target    | 0.6117 | 0.6117 |          0.037 |
|    0.05 | bimodal, modes 10x apart       | 0.8000 | 0.8000 |          0.000 |
|    0.05 | pareto, heavy tail             | 0.9616 | 0.9617 |          0.025 |
|    0.05 | two-point, 90/10 in one bucket | 0.9500 | 0.9507 |          0.665 |
|    0.05 | gaussian cluster in one bucket | 0.7499 | 0.7320 |         17.848 |
|    0.01 | lognormal, median at target    | 0.6117 | 0.6117 |          0.015 |
|    0.01 | bimodal, modes 10x apart       | 0.8000 | 0.8000 |          0.000 |
|    0.01 | pareto, heavy tail             | 0.9616 | 0.9617 |          0.057 |
|    0.01 | two-point, 90/10 in one bucket | 0.9500 | 0.6254 |    **324.583** |
|    0.01 | gaussian cluster in one bucket | 0.7503 | 0.6339 |    **116.411** |
|   0.001 | lognormal, median at target    | 0.6117 | 0.6117 |          0.032 |
|   0.001 | bimodal, modes 10x apart       | 0.8000 | 0.8000 |          0.000 |
|   0.001 | pareto, heavy tail             | 0.9616 | 0.9616 |          0.001 |
|   0.001 | two-point, 90/10 in one bucket | 0.9500 | 0.7922 |        157.837 |
|   0.001 | gaussian cluster in one bucket | 0.7488 | 0.7921 |         43.212 |

Three things follow, and only the third is the decision:

1. **On a spread distribution the derived score is excellent** — worst 0.057
   points, below the resolution APDEX is quoted at. Had the measurement stopped
   here, the "no new state" design would have shipped.
2. **When the mass concentrates inside one bucket straddling the threshold, it
   is wrong by most of that bucket.** 324 points is not a rounding difference; it
   is a score of 0.625 reported for a service attaining 0.950.
3. **The error is not monotonic in `alpha`** — 0.665 at 0.05, 324 at 0.01, 158 at
   0.001. It depends on where the threshold happens to fall inside the bucket,
   which is arbitrary. A finer sketch is not a safer one, so there is no accuracy
   setting that makes the derived score trustworthy.

The realistic version of the clustered case does not look adversarial. A service
whose latency is a fixed cost, with the SLO set at that cost, puts a point mass
exactly on the threshold — and a point mass at 100 ms is reported as roughly a
quarter of itself, because the sketch cannot distinguish it from a spread across
the bucket containing it. A service operating at its own SLO boundary is exactly
that distribution, which makes the derived score worst precisely where it is
being watched.

Cost, same run, 2,000,000 ops, median of 7:

| path                                   | ns/sample |
| -------------------------------------- | --------: |
| three-counter classify                 |      4.82 |
| `histogram.record()`                   |     48.51 |
| `countAtOrBelow()`                     |     16.05 |
| **derived score** (record + 2 queries) | **80.61** |

The exact path is a seventeenth of the cost and `O(1)` in memory, where the
derived path is `O(occupied buckets)`.

## Decision

**Ship `PowerApdex` with three integer counters, and do not build the score on
`countAtOrBelow()`.**

The counters are exact at every accuracy, cheaper per sample, and constant in
memory. `merge()` is exact too, so per-worker scorers aggregate without the
boundary error a rank query would introduce.

**`PowerHistogram.countAtOrBelow()` ships anyway**, as a general rank query. It
is the genuine inverse of `percentile()`, it answers "what fraction of my
requests were under X" — the most common latency question after percentiles, and
one the sketch could not answer at all before — and the measurement above says it
answers that question well on a spread distribution. What it must not be used for
is an SLO attainment figure, and both the method's JSDoc and
`guides/powerHistogram.md` say so, with the number.

## The rejected alternative

**`apdex(histogram, { target, tolerance })` as a pure function over the existing
sketch.** Rejected on point 2 and 3 above. It is recorded here rather than left
implicit because it is the design a reader will arrive at independently: it is
less code, it adds no state, and on any casually-chosen test distribution it
looks correct. The failure needs a distribution built to concentrate mass at the
threshold, which is why the bench mode exists and why the guide names the case
explicitly instead of saying "approximate".

A second rejected variant: **`PowerApdex` backed by a `PowerHistogram` at a fine
`relativeAccuracy`.** This shrinks the bucket but never removes the straddle, and
point 3 says the error does not even track `alpha` monotonically, so tuning it is
not a repair. It also pays sketch cost for a counter's job.

## Composition: recipes, not meta helpers

The obvious follow-up question is what `PowerApdex` should be wired to. Three
options were considered: feed the score into the existing adaptive helpers, build
new meta helpers that compose it, or document recipes.

**Recipes were chosen, and the adaptive wiring was rejected on the shape of the
signal rather than on cost.** Every adaptive helper here consumes a signed,
unbounded, gradient-carrying quantity: `PowerServo` and `PowerFlowControl` are
PID loops over a `setpoint`, `PowerAdaptiveProposal.propose(signal)` reads a
positive signal as "decrease" and a negative one as "increase" with the magnitude
meaning how far to move, and `PowerPool`'s autoscale steers on an EWMA of task
latency in milliseconds. APDEX is none of those. It saturates at `1.0`, and at
`1.0` it is blind: when every request is under `target`, the distance to falling
below `0.95` could be 1% more load or 500% more load, and the score cannot tell
them apart, because the map from system state to APDEX is many-to-one and
load-dependent. A controller needs exactly that distinction, which is why the
pool steers on latency.

So `score()` belongs on the **predicate** side of a decision and never on the
**gradient** side. The one sound composition is a gate — an APDEX below the SLO
floor raising `PowerBrownout` pressure — and that is three lines of caller code,
which is why it is a recipe in `guides/powerApdex.md` rather than a class. A meta
helper would be glue around existing pieces, and the debouncing it might add is
already available as `PowerAdaptiveProposal`'s `hysteresis` and `cooldown`.

This is recorded rather than left implicit because it is the next thing someone
will reasonably try, and the failure is silent: an APDEX-driven loop works near
its setpoint and then goes blind at `1.0`, which looks like a well-tuned
controller until the load ramp.

**Not measured:** an APDEX-driven step controller against the EWMA-latency
controller the pool already uses, under a load ramp, on time-to-target and
overshoot. The argument above is structural, not empirical. If someone wants the
adaptive wiring anyway, that bench mode — `bench/claims.js apdexsignal`, reusing
the `stepsize` and `concurrency` harness shapes — is the first task, not the
implementation.

## What survives

- `PowerApdex` — `src/helpers/powerApdex.js`, with `record()`, `score()`,
  `merge()`, `reset()`, `stats()`/`getStats()`, and dispose as a state reset.
- `PowerHistogram.countAtOrBelow()` — the rank query, with its bound documented
  on the method and in the guide.
- `bench/claims.js apdex` — BENCH-002m, so the next proposal to derive a score
  from a sketch finds the measurement rather than repeating the work.
- `test/powerApdex.test.js` pins the concentrated case exactly, and
  `test/powerHistogram.countAtOrBelow.test.js` pins the bound as a property. The
  latter's "under-counts a point mass sitting exactly on the threshold" case is a
  **characterisation, not an aspiration**: it documents a loss, and it says so.

## Not measured

- **A distribution with mass at the threshold that is _not_ inside one bucket.**
  The two clustered cases place their mass within `alpha / 2` of the threshold by
  construction, so they are always inside a single bucket. A cluster wide enough
  to span several buckets would interpolate better, and the truth is somewhere
  between the spread rows and the clustered ones. The adversarial construction is
  the right one for a worst case; it is not a claim about every concentrated
  distribution.
- **Non-latency uses of APDEX.** The formula is sometimes applied to error rates
  and other unitless ratios. Only latency was measured, and only latency is
  documented.
- **A windowed or decaying score.** APDEX is conventionally computed over a
  reporting window, and this helper accumulates until `reset()`. A sliding
  variant would need its own design and its own measurement; it is not a
  configuration option on this one.
