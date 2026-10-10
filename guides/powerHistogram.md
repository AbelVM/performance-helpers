# PowerHistogram

Lock-free in-process histogram for latency telemetry and approximate percentile estimation.

`PowerHistogram` records latency values and derives percentile estimates without sorting or storing raw samples. It is built on a [DDSketch](https://dl.acm.org/doi/10.14778/3361349.3361381) (Masson, Rim & Lee, _PVLDB_ 12(12):2195-2205, 2019) — the format OpenTelemetry uses for its own histogram aggregator.

## Why DDSketch

Each positive value `v` is mapped to a logarithmic bucket:

```
index(v) = ceil( ln(v) / ln(gamma) )      gamma = (1 + alpha) / (1 - alpha)
value(i) = 2 · gamma^i / (1 + gamma)
```

That buys three things:

- **A relative error bound.** Every quantile is within `relativeAccuracy` of the true value, at _any_ magnitude. A fixed-bucket histogram only gives you a _rank_ bound, which degrades badly exactly in the tail you care about.
- **An unbounded range.** There is no `maxValue` to exceed. `1e-300` and `1e300` are two buckets apart, not clamped.
- **Exact merging.** Bucket indices are absolute, so a per-worker histogram merges into a global one. Rank-error sketches (t-digest, GK, KLL) are only one-way mergeable.

> **Changed in 2.x.** Earlier versions used a fixed dense range of `[minValue, maxValue]` and **clamped** anything outside it into the first/last bucket. That silently corrupted data: with the old defaults, a histogram of 99 samples of `1 ms` plus one of `1e8 ms` reported `p99.9 = 20000` — a 5000× under-report with no warning. That input now reports `1.0099e8`, within the 1 % bound. If you relied on clamping, use the new `outOfRangeCount` / `belowRangeCount` counters to detect it instead.

## Constructor

| Option             |     Type | Default | Description                                                                                                      |
| ------------------ | -------: | ------: | ---------------------------------------------------------------------------------------------------------------- |
| `relativeAccuracy` | `number` |  `0.01` | Target relative error for every quantile, in `(0, 1)` exclusive. Smaller is more accurate and uses more buckets. |
| `maxValue`         | `number` | `10000` | **Advisory** upper bound. Values above it are stored faithfully and only counted in `outOfRangeCount`.           |
| `minValue`         | `number` |     `0` | **Advisory** lower bound. Values below it are stored faithfully and only counted in `belowRangeCount`.           |
| `bucketCount`      | `number` |       — | Legacy. Accepted so existing calls keep working; it no longer sizes a dense array.                               |

`relativeAccuracy` must be in `(0, 1)`; anything else throws a `TypeError`.

## API

- `record(value)` — Record a value. Throws `TypeError` for negative or `NaN`. `+Infinity` is accepted and tracked separately. `0` gets its own exact bucket.
- `percentile(q)` — Estimated percentile for `q` in `0..100` or `0..1`. Returns `undefined` when empty.
- `countAtOrBelow(value)` — Estimated number of samples **at or below** `value`. The inverse of `percentile()`. See [Rank queries](#rank-queries-countatorbelow).
- `merge(other)` — Absorb another `PowerHistogram`. Throws if the two use different `relativeAccuracy` (bucket indices are not comparable), or if `other` is not a `PowerHistogram`.
- `PowerHistogram.fromJSON(obj)` — **New in 2.0.** Static. Rebuild a sketch from a `toJSON()` result. This is the missing half of the distributed path: `toJSON()` has always existed, but `structuredClone` does not preserve the class, so a sketch arriving from a worker is a _plain object_ — and `merge()` used to reject it with "expects a PowerHistogram". The headline use case was unreachable without hand-rolling reconstruction, which is exactly the kind of thing that gets the bucket indices wrong.
- `reset()` — Clear all recorded values and statistics.
- `toJSON()` — Serializable `{ relativeAccuracy, count, sum, min, max, zeroCount, infCount, outOfRangeCount, belowRangeCount, buckets }` for shipping to a metrics backend or merging elsewhere.
- `count`, `sum`, `mean` — Exact. `count` is every record recorded; `mean` averages the records that carry a value, so a `+Infinity` is counted in `count` and in `infCount` but left out of the average. A histogram of nothing but `+Infinity` reports `mean` of `Infinity`.
- `min`, `max` — Exact, or `undefined` when empty.
- `relativeAccuracy` — The configured bound.
- `bucketCount` — Number of **occupied** buckets (not a fixed array size).
- `outOfRangeCount`, `belowRangeCount` — How many values fell outside the advisory bounds.
- `snapshot()` — Bucket counts ordered lowest to highest. Layout: `[zero, ...buckets, inf?]`. The leading entry is the exact-zero count and the `+Infinity` bucket is **appended** when present. The counts always sum to `count`.

## Example

```javascript
import { PowerHistogram } from 'performance-helpers/powerHistogram';

const histogram = new PowerHistogram({ relativeAccuracy: 0.01 });

for (const latency of [5, 12, 7, 20, 40, 100, 200]) {
  histogram.record(latency);
}

console.log('count', histogram.count);
console.log('mean', histogram.mean.toFixed(1));
console.log('p50', histogram.percentile(50));
console.log('p90', histogram.percentile(90));
console.log('p99', histogram.percentile(99));
```

## Real-world usage

Ideal for in-process telemetry inside worker pools, request handlers, or batch processors. The sketch is `O(1)` per record and one `Math.log`.

```javascript
import { PowerHistogram } from 'performance-helpers/powerHistogram';

const latency = new PowerHistogram({ relativeAccuracy: 0.01 });

async function handleRequest(req) {
  const start = performance.now();
  await processRequest(req);
  latency.record(performance.now() - start);
}
```

### Aggregating per-worker histograms

Because merges are exact, keep one sketch per worker and fold them together for reporting. This is not possible with rank-error sketches without loss.

```javascript
import { PowerPool, PowerHistogram } from 'performance-helpers';

const pool = new PowerPool(workerSource, { size: 4 });
const perWorker = new Map();

pool.addEventListener('message', (e) => {
  const { workerId, durationMs } = e.data;
  let h = perWorker.get(workerId);
  if (!h) perWorker.set(workerId, (h = new PowerHistogram()));
  h.record(durationMs);
});

// later
const global = new PowerHistogram();
for (const h of perWorker.values()) global.merge(h);
console.log('fleet p99', global.percentile(99));
```

### Shipping a sketch across a worker boundary

`merge()` accepts a `PowerHistogram`, a cross-realm `PowerHistogram`, **or** a
`toJSON()` result — so the plain object a worker hands back after
`structuredClone` merges directly, with no reconstruction step:

```javascript
// in the worker
postMessage(histogram.toJSON());

// on the main thread
worker.addEventListener('message', (e) => {
  // e.data is a plain object, not a PowerHistogram — and that is fine
  global.merge(e.data);
});
```

`PowerHistogram.fromJSON()` is there for when you want the sketch back as an
instance rather than folded into an existing one:

```javascript
const restored = PowerHistogram.fromJSON(e.data);
console.log('worker p99', restored.percentile(99));
```

The check is **structural** rather than `instanceof`, because `instanceof` is
`false` for a value from another realm and `structuredClone` does not preserve
the class at all. Both shapes carry the same fields, so the test is on the
fields — and a `Symbol.toStringTag` spoof is rejected, because the check reads
real properties rather than a tag.

## Rank queries: `countAtOrBelow()`

`percentile()` answers "what value is at rank _q_". `countAtOrBelow()` answers the other direction — "how many samples were at or below _v_" — which is the question behind every SLO attainment figure:

```javascript
import { PowerHistogram } from 'performance-helpers/powerHistogram';

const latency = new PowerHistogram({ relativeAccuracy: 0.01 });
// ... record ...
const under100 = latency.countAtOrBelow(100);
console.log(`${((under100 / latency.count) * 100).toFixed(1)}% of requests under 100 ms`);
```

The boundary is **inclusive**, which is the class APDEX calls "satisfied". The name is `countAtOrBelow` rather than `countBelow` because `belowRangeCount` already means _strictly_ below in this class.

### What the estimate rests on

Every occupied bucket below the one `value` falls into is counted in full, because such a bucket's entire multiplicative range lies at or below `value`. The boundary bucket is **interpolated**: the share of its log-range at or below `value` is applied to its count. So the error is bounded by the mass sitting in that one bucket, and by nothing else.

That bound is the whole guarantee, and it is worth knowing where it bites:

| Distribution                               | Error, as a share of samples |
| ------------------------------------------ | ---------------------------: |
| lognormal, pareto, bimodal (spread)        |                    < 0.001 % |
| mass concentrated inside one bucket at _v_ |                  up to 100 % |

The second row is not a bug and no value of `relativeAccuracy` repairs it — the mass is always inside one bucket, and the error is not even monotonic in `alpha`, because it depends on where the threshold happens to fall inside that bucket. `bench/claims.js apdex` measures it: a derived APDEX of **0.625 against a truth of 0.950**.

The realistic version of that case does not look adversarial. A service whose latency is a fixed cost, with the SLO set at that cost, puts a point mass exactly on the threshold — and a point mass at 100 ms is reported as roughly a quarter of itself, because the sketch cannot tell it from a spread across the bucket containing it.

**So: use `countAtOrBelow()` for "what fraction of requests were under X" on a spread distribution, and use [`PowerApdex`](powerApdex.md) when the number is an SLO attainment figure.** APDEX keeps three integer counters for exactly this reason.

## Notes

- `percentile` returns the **midpoint of the bucket**, not a stored sample. With `relativeAccuracy: 0.01` a sketch of only the value `42` reports `p50 ≈ 41.68` — that is the guarantee working, not drift. Assert on relative error, not exact equality.
- Smaller `relativeAccuracy` means more buckets and slightly more work per record; `0.001` is a reasonable choice when you need a trustworthy `p99.9`.
- `count`, `sum`, `mean`, `min` and `max` are **exact** — only the quantiles are estimated.
- Because `maxValue` is now advisory, set it to the range you expect and alert on `outOfRangeCount > 0` if you want to catch a configuration that no longer matches reality.
- **Quantiles are clamped into `[min, max]`.** A bucket's representative value is the midpoint of its multiplicative range, so the lowest non-zero bucket can report slightly below the true `min`. Without the clamp `percentile(0)` (which returns the exact `min`) came out _above_ `percentile(5)` — a visible non-monotonic p0 > p5 curve. Clamping is safe because `min` and `max` are exact, so the relative bound still holds.
- **`percentile(1)` is the maximum, not the 1st percentile.** Any argument in `(0, 1]` is read as a _fraction_, so `1` means `1.0` = p100. Use `0.5` for p50 or `50` for p50 — both work, but `1` is the one to watch.
- **A DDSketch bounds values, not ranks.** With a handful of samples, working out which rank a quantile lands on dominates and the effective value error approaches `2 x relativeAccuracy`. The bound tightens as the sample count grows.
- **`countAtOrBelow()` is not an integer** when the threshold lands mid-bucket. Rounding it would bias every such threshold in the same direction, so it is left fractional; `Math.round()` is one call away if you need a whole number.
- **`countAtOrBelow()` is O(log b)** over occupied buckets, not O(n): the bucket order and its cumulative counts are cached and rebuilt only when the bucket set changes. A dashboard can call it on every scrape without the cost scaling with the spread of the data.
