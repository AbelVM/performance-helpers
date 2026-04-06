# PowerHistogram

Lock-free in-process histogram for latency telemetry and approximate percentile estimation.

`PowerHistogram` is designed for workloads that need to record latency values and derive percentile estimates without expensive sorting or merging of raw samples.

## Constructor

| Option | Type | Default | Description |
|---|---:|---:|---|
| `minValue` | `number` | `1` | Lower bound for the first non-zero bucket. Values below this bound are aggregated in the first bucket. |
| `maxValue` | `number` | `10000` | Upper bound for the sketch range. Values above this bound are aggregated in the last bucket. |
| `bucketCount` | `number` | `128` | Number of internal buckets used to approximate the distribution. |

## API

- `record(value)` — Record a numeric latency or measurement value. Throws for negative or non-finite values.
- `percentile(q)` — Return an estimated percentile value for `q` in `0..100`, or `0..1`. Returns `undefined` when no samples exist.
- `reset()` — Clear all recorded values and reset statistics.
- `count` — Total number of values recorded.
- `sum` — Sum of all recorded values.
- `mean` — Average of all recorded values.
- `min` — Minimum recorded value, or `undefined` when empty.
- `max` — Maximum recorded value, or `undefined` when empty.
- `snapshot()` — Return a snapshot copy of internal bucket counts.

## Example

```javascript
import { PowerHistogram } from '../src/helpers/powerHistogram.js';

const histogram = new PowerHistogram({ minValue: 1, maxValue: 2000, bucketCount: 64 });

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

Use `PowerHistogram` when you need to capture latency distributions with a small memory footprint and fast writes. It is ideal for in-process telemetry inside worker pools, request handlers, or batch processors.

```javascript
import { PowerHistogram } from '../src/helpers/powerHistogram.js';

const latency = new PowerHistogram({ maxValue: 10000, bucketCount: 128 });

async function handleRequest(req) {
  const start = performance.now();
  await processRequest(req);
  latency.record(performance.now() - start);
}

setInterval(() => {
  console.log('p50', latency.percentile(50));
  console.log('p90', latency.percentile(90));
  console.log('p99', latency.percentile(99));
}, 10_000);
```

## Notes

- `PowerHistogram` is approximate by design; percentile values are estimated from bucket boundaries.
- The internal bucket count controls accuracy versus memory usage.
- `count`, `sum`, `mean`, `min`, and `max` are exact values.
