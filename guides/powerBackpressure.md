# PowerBackpressure

Producer-facing backpressure controller with adaptive refill.

`PowerBackpressure` is designed to help producers throttle themselves when downstream capacity is limited. It provides a permit-based API and automatically refills permits when pressure is high.

## Constructor

| Option           |                Type |                                  Default | Description                                                                                                                                                               |
| ---------------- | ------------------: | ---------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capacity`       |            `number` |                                    `100` | Maximum number of concurrent permits.                                                                                                                                     |
| `queueCapacity`  |            `number` |                                   `1000` | Maximum number of producers that may wait for a permit.                                                                                                                   |
| `lowWaterMark`   |            `number` |             `Math.ceil(capacity * 0.25)` | When available permits fall below this threshold, adaptive refill begins.                                                                                                 |
| `refillAmount`   |            `number` | `Math.max(1, Math.ceil(capacity * 0.1))` | Base number of permits restored during each adaptive refill.                                                                                                              |
| `refillInterval` |            `number` |                                    `200` | Refill interval in milliseconds when pressure is high.                                                                                                                    |
| `initialTokens`  |            `number` |                               `capacity` | Initial available permits.                                                                                                                                                |
| `adaptive`       | `boolean`\|`Object` |                                  `false` | AIMD tuning of `refillAmount`. `true` takes the defaults; an object configures `additiveIncrease`, `beta`, `min` and `max`. See [Adaptive refill](#adaptive-refill-aimd). |

## API

- `acquire()` — Returns a `Promise<Function>` that resolves when a permit is available. The resolved function releases the permit.
- `tryAcquire()` — Immediately returns a release callback when a permit is available, or `null` when unavailable.
- `release(count?)` — Release one or more permits back to the controller.
- `reset()` — Clear waiting producers and restore available permits up to `capacity`, less any permits still held by callers that have not released.
- `capacity` — Maximum concurrent permits.
- `available` — Number of permits currently available.
- `pending` — Number of waiting producers.
- `queueCapacity` — Maximum queued producers.
- `isFull` — `true` when the waiting queue is saturated.
- `dispose()` / `[Symbol.dispose]()` — Release resources and detach any internal timers. Supports `using` / `await using`. See [Disposal](#disposal).

## Disposal

`PowerBackpressure` implements `dispose()` and `[Symbol.dispose]`, so it works with
`using` / `await using` and with a DI container's teardown, like every other
long-lived helper here.

```javascript
{
  using bp = new PowerBackpressure({ capacity: 64, queueCapacity: 100 });
  const release = await bp.acquire();
  // ...
} // dispose() runs here
```

**There is a timer to cancel.** The adaptive refill path schedules a recurring
refill tick when pressure is high, and `dispose()` cancels it. Saying it "is a
state reset" would describe the limiters, not this helper: the timer is real, and
leaving it running after teardown would keep the process alive for no reason.

`reset()` does **not** cancel the timer. It returns the window to its configured
`refillAmount` and clears waiting producers, but the tick continues. Use
`dispose()` when you are finished with the instance.

## Adaptive refill (AIMD)

Off by default. With `adaptive: true` the refill amount becomes a congestion
window in the TCP sense, tuned by what the consumers do with the permits they
are given:

- **Additive increase** — a refill tick that finds at least one permit has come
  back grows the window by `additiveIncrease` (default 1).
- **Multiplicative decrease** — a refill tick that finds _every_ permit still
  out, however long the consumer has held them, cuts the window by `beta`
  (default 0.5, clamped to `(0.1, 0.99)`).

The signal is deliberately not a clock. CoDel judges congestion from a
round-trip delay; the honest analogue here is "did my probe come back", which
needs no timer and cannot be fooled by a consumer that is fast but keeps
everything.

```js
const bp = new PowerBackpressure({
  capacity: 64,
  adaptive: { additiveIncrease: 2, beta: 0.5, min: 1 },
});
// bp.refillAmount reads the current window; reset() returns it to its base.
```

Two things worth knowing:

- **It only observes under load.** If the queue is empty there is nothing to
  measure and the window does not move. That is correct: a system that is not
  saturated has no reason to probe harder.
- **`reset()` puts the window back to its configured `refillAmount`.** Carrying a
  tuned window across a reset would keep applying a conclusion drawn about a
  workload that no longer exists. It does _not_ clear the in-flight count: the
  consumers that count are still running, so their permits are still held.

In-flight accounting is exact — a permit is counted when it reaches a consumer
and decremented when it comes back — and a release that hands a permit straight
to a queued producer is a _transfer_, so the count is unchanged across it.

### `capacity` is a pool here, and a ceiling in `PowerSemaphore`

Unlike `PowerSemaphore` and `PowerBulkhead`, where `capacity` is a hard ceiling
on concurrent holders, `capacity` here sizes the **pool** the refill draws from.
So `active` can read above `capacity`: when consumers are not returning their
permits the refill mints more, because a consumer that is not coping is exactly
the case where more producers have to be let in. The AIMD window is what
corrects it — a tick that finds every permit still out cuts `refillAmount`, so
the rate falls again.

This also means the refill cannot relieve a queue whose every permit is out and
never coming back. That is the pressure the class exists to express, not
something a timer can schedule around.

`active` counts holders rather than reporting `capacity - available` precisely
because it has to: the latter cannot exceed `capacity`, so it would sit pinned at
the ceiling and read as a healthy gate exactly when the work is piling up. The
model and the two rejected alternatives are in
[ADR 0004](../adr/0004-permit-capacity-ceiling-or-pool.md).

## Constructor

| Option           |                Type |                                  Default | Description                                                                                                                                                               |
| ---------------- | ------------------: | ---------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capacity`       |            `number` |                                    `100` | Maximum number of concurrent permits.                                                                                                                                     |
| `queueCapacity`  |            `number` |                                   `1000` | Maximum number of producers that may wait for a permit.                                                                                                                   |
| `lowWaterMark`   |            `number` |             `Math.ceil(capacity * 0.25)` | When available permits fall below this threshold, adaptive refill begins.                                                                                                 |
| `refillAmount`   |            `number` | `Math.max(1, Math.ceil(capacity * 0.1))` | Base number of permits restored during each adaptive refill.                                                                                                              |
| `refillInterval` |            `number` |                                    `200` | Refill interval in milliseconds when pressure is high.                                                                                                                    |
| `initialTokens`  |            `number` |                               `capacity` | Initial available permits.                                                                                                                                                |
| `adaptive`       | `boolean`\|`Object` |                                  `false` | AIMD tuning of `refillAmount`. `true` takes the defaults; an object configures `additiveIncrease`, `beta`, `min` and `max`. See [Adaptive refill](#adaptive-refill-aimd). |

## Example

```javascript
import { PowerBackpressure } from '../src/helpers/powerBackpressure.js';
import { PowerPool } from '../src/helpers/powerPool.js';

const pool = new PowerPool('./worker.js', { size: 2, maxSize: 4 });
const backpressure = new PowerBackpressure({
  capacity: 8,
  queueCapacity: 100,
  lowWaterMark: 2,
  refillAmount: 2,
  refillInterval: 100,
});

async function publishTask(task) {
  const release = await backpressure.acquire();
  try {
    await pool.postMessage(task, undefined, { awaitResponse: true, timeout: 5000 });
  } finally {
    release();
  }
}

async function ingestStream(stream) {
  for await (const event of stream) {
    publishTask({ op: 'process-event', payload: event }).catch((err) => {
      console.error('task failed', err);
    });
  }
}
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

### Try-acquire fallback

When low-latency callers prefer to avoid awaiting a permit, use `tryAcquire()`
to attempt immediate admission and provide a fallback path (drop, persist, or retry).

```javascript
function tryPublish(task) {
  const release = backpressure.tryAcquire();
  if (!release) {
    // fallback: persist for later retry, drop, or send to an alternate queue
    persistTask(task);
    return false;
  }

  // fire-and-forget path; ensure release is called when done
  pool.postMessage(task);
  // release immediately because we only used the permit to control enqueueing
  release();
  return true;
}
```

## Notes

- `PowerBackpressure` is producer-facing; it does not execute tasks itself.
- `acquire()` is the recommended API for safe usage because it always returns a release callback.
- `refillAmount` and `refillInterval` control how aggressively the controller responds when producers are waiting.
