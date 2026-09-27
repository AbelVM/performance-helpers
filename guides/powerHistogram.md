# PowerHistogram

Lock-free in-process histogram for latency telemetry and approximate percentile estimation.

`PowerHistogram` records latency values and derives percentile estimates without sorting or storing raw samples. It is built on a [DDSketch](https://dl.acm.org/doi/10.14778/3361349.3361381) (Masson, Rim & Lee, *PVLDB* 12(12):2195-2205, 2019) — the format OpenTelemetry uses for its own histogram aggregator.

## Why DDSketch

Each positive value `v` is mapped to a logarithmic bucket:

```
index(v) = ceil( ln(v) / ln(gamma) )      gamma = (1 + alpha) / (1 - alpha)
value(i) = 2 · gamma^i / (1 + gamma)
```

That buys three things:

- **A relative error bound.** Every quantile is within `relativeAccuracy` of the true value, at *any* magnitude. A fixed-bucket histogram only gives you a *rank* bound, which degrades badly exactly in the tail you care about.
- **An unbounded range.** There is no `maxValue` to exceed. `1e-300` and `1e300` are two buckets apart, not clamped.
- **Exact merging.** Bucket indices are absolute, so a per-worker histogram merges into a global one. Rank-error sketches (t-digest, GK, KLL) are only one-way mergeable.

> **Changed in 2.x.** Earlier versions used a fixed dense range of `[minValue, maxValue]` and **clamped** anything outside it into the first/last bucket. That silently corrupted data: with the old defaults, a histogram of 99 samples of `1 ms` plus one of `1e8 ms` reported `p99.9 = 20000` — a 5000× under-report with no warning. That input now reports `1.0099e8`, within the 1 % bound. If you relied on clamping, use the new `outOfRangeCount` / `belowRangeCount` counters to detect it instead.

## Constructor

| Option | Type | Default | Description |
|---|---:|---:|---|
| `relativeAccuracy` | `number` | `0.01` | Target relative error for every quantile, in `(0, 1)` exclusive. Smaller is more accurate and uses more buckets. |
| `maxValue` | `number` | `10000` | **Advisory** upper bound. Values above it are stored faithfully and only counted in `outOfRangeCount`. |
| `minValue` | `number` | `0` | **Advisory** lower bound. Values below it are stored faithfully and only counted in `belowRangeCount`. |
| `bucketCount` | `number` | — | Legacy. Accepted so existing calls keep working; it no longer sizes a dense array. |

`relativeAccuracy` must be in `(0, 1)`; anything else throws a `TypeError`.

## API

- `record(value)` — Record a value. Throws `TypeError` for negative or `NaN`. `+Infinity` is accepted and tracked separately. `0` gets its own exact bucket.
- `percentile(q)` — Estimated percentile for `q` in `0..100` or `0..1`. Returns `undefined` when empty.
- `merge(other)` — Absorb another `PowerHistogram`. Throws if the two use different `relativeAccuracy` (bucket indices are not comparable), or if `other` is not a `PowerHistogram`.
- `reset()` — Clear all recorded values and statistics.
- `toJSON()` — Serializable `{ relativeAccuracy, count, sum, min, max, zeroCount, infCount, outOfRangeCount, belowRangeCount, buckets }` for shipping to a metrics backend or merging elsewhere.
- `count`, `sum`, `mean` — Exact.
- `min`, `max` — Exact, or `undefined` when empty.
- `relativeAccuracy` — The configured bound.
- `bucketCount` — Number of **occupied** buckets (not a fixed array size).
- `outOfRangeCount`, `belowRangeCount` — How many values fell outside the advisory bounds.
- `snapshot()` — Bucket counts from lowest to highest, leading entry being the zero bucket.

## Example

```javascript
import { PowerHistogram } from '../src/helpers/powerHistogram.js';

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
import { PowerHistogram } from '../src/helpers/powerHistogram.js';

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
import { PowerPool, PowerHistogram } from '../src/index.js';

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

## Notes

- `percentile` returns the **midpoint of the bucket**, not a stored sample. With `relativeAccuracy: 0.01` a sketch of only the value `42` reports `p50 ≈ 41.68` — that is the guarantee working, not drift. Assert on relative error, not exact equality.
- Smaller `relativeAccuracy` means more buckets and slightly more work per record; `0.001` is a reasonable choice when you need a trustworthy `p99.9`.
- `count`, `sum`, `mean`, `min` and `max` are **exact** — only the quantiles are estimated.
- Because `maxValue` is now advisory, set it to the range you expect and alert on `outOfRangeCount > 0` if you want to catch a configuration that no longer matches reality.
