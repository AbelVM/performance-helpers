# PowerPermitGate

Low-level permit queue helper for building semaphore-like concurrency primitives.

`PowerPermitGate` manages a pool of permits and a FIFO queue of waiting callers. It is useful when you need a reusable gate with explicit `acquire()` / `release()` semantics and bounded waiting.

## Constructor

| option | type | default | description |
|---|---:|---:|---|
| `capacity` | `number` | `1` | Maximum number of permits available concurrently. |
| `queueCapacity` | `number` | `Infinity` | Maximum number of waiting callers allowed in the queue. |
| `initialTokens` | `number` | `capacity` | Number of permits available immediately after construction. |

## API

- `acquire()` — Returns a `Promise` that resolves to a release callback when a permit becomes available. If a permit is immediately available, the promise resolves synchronously.
- `tryAcquire()` — Returns a release callback if a permit is available immediately, or `null` if no permit is available.
- `release(count?)` — Releases one or more permits back into the gate and dispatches queued waiters in FIFO order.
- `reset(options?)` — Clears queued waiters and optionally restores available permits. Waiters are rejected with a provided reason.
- `capacity` — Total permit count.
- `available` — Current available permit count.
- `pending` — Number of queued waiters.
- `queueCapacity` — Maximum allowed queue size.
- `isFull` — `true` when the wait queue is saturated.

## Example

```js
import { PowerPermitGate } from '../src/helpers/powerPermitGate.js';

const gate = new PowerPermitGate({ capacity: 2, queueCapacity: 10 });

async function doWork(id) {
  const release = await gate.acquire();
  try {
    console.log('working', id);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    release();
  }
}

const tasks = [1, 2, 3, 4].map((id) => doWork(id));
await Promise.all(tasks);
```

## Notes

- `PowerPermitGate` is a good primitive for building higher-level concurrency helpers such as `PowerSemaphore`, `PowerBackpressure`, or `PowerBulkhead`.
- When queue capacity is reached, `acquire()` rejects immediately with a queue-full error.
- The release callback returned by `acquire()` is idempotent: calling it more than once has no effect.
