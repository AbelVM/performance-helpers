# PowerBackpressure

Producer-facing backpressure controller with adaptive refill.

`PowerBackpressure` is designed to help producers throttle themselves when downstream capacity is limited. It provides a permit-based API and automatically refills permits when pressure is high.

## Constructor

| Option | Type | Default | Description |
|---|---:|---:|---|
| `capacity` | `number` | `100` | Maximum number of concurrent permits.
| `queueCapacity` | `number` | `1000` | Maximum number of producers that may wait for a permit.
| `lowWaterMark` | `number` | `Math.ceil(capacity * 0.25)` | When available permits fall below this threshold, adaptive refill begins.
| `refillAmount` | `number` | `Math.max(1, Math.ceil(capacity * 0.1))` | Base number of permits restored during each adaptive refill.
| `refillInterval` | `number` | `200` | Refill interval in milliseconds when pressure is high.
| `initialTokens` | `number` | `capacity` | Initial available permits.

## API

- `acquire()` — Returns a `Promise<Function>` that resolves when a permit is available. The resolved function releases the permit.
- `tryAcquire()` — Immediately returns a release callback when a permit is available, or `null` when unavailable.
- `release(count?)` — Release one or more permits back to the controller.
- `reset()` — Clear waiting producers and restore available permits to capacity.
- `capacity` — Maximum concurrent permits.
- `available` — Number of permits currently available.
- `pending` — Number of waiting producers.
- `queueCapacity` — Maximum queued producers.
- `isFull` — `true` when the waiting queue is saturated.

## Example

```javascript
import { PowerBackpressure } from '../src/helpers/powerBackpressure.js';

const backpressure = new PowerBackpressure({
  capacity: 5,
  queueCapacity: 50,
  refillAmount: 2,
  refillInterval: 50,
});

async function produce(item) {
  const release = await backpressure.acquire();
  try {
    await sendToWorker(item);
  } finally {
    release();
  }
}

await Promise.all(items.map(produce));
```

## Real-world usage

Use `PowerBackpressure` when a producer must slow down to match downstream capacity or avoid unbounded queue growth. It is a good fit in front of `PowerPool`, stream processing, or network request emitters.

```javascript
import { PowerBackpressure } from '../src/helpers/powerBackpressure.js';
import { PowerPool } from '../src/helpers/powerPool.js';

const pool = new PowerPool(workerFactory, { maxSize: 4 });
const backpressure = new PowerBackpressure({ capacity: 8, queueCapacity: 32 });

async function enqueueTask(task) {
  const release = await backpressure.acquire();
  try {
    pool.postMessage(task);
  } finally {
    release();
  }
}
```

## Notes

- `PowerBackpressure` is producer-facing; it does not execute tasks itself.
- `acquire()` is the recommended API for safe usage because it always returns a release callback.
- `refillAmount` and `refillInterval` control how aggressively the controller responds when producers are waiting.
