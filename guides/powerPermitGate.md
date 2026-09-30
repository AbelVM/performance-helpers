# PowerPermitGate

Low-level permit queue helper for building semaphore-like concurrency primitives.

`PowerPermitGate` manages a pool of permits and a FIFO queue of waiting callers. It is useful when you need a reusable gate with explicit `acquire()` / `release()` semantics and bounded waiting.

## Constructor

| option          |     type |    default | description                                                 |
| --------------- | -------: | ---------: | ----------------------------------------------------------- |
| `capacity`      | `number` |        `1` | Maximum number of permits available concurrently.           |
| `queueCapacity` | `number` | `Infinity` | Maximum number of waiting callers allowed in the queue.     |
| `initialTokens` | `number` | `capacity` | Number of permits available immediately after construction. |

### Cancelling a wait

`acquire({ signal })` stops waiting. The returned promise rejects with an
`AbortError` and the caller leaves the queue — it does not wait for a permit
that may never come, and it does not hold a queue slot in the meantime.

```js
const controller = new AbortController();
const pending = gate.acquire({ signal: controller.signal });
controller.abort();
await pending; // rejects: AbortError
```

Three details that are easy to get wrong and are worth stating plainly:

- **An already-aborted signal rejects even when a permit is free.** Passing a
  dead signal means "do not do this", and answering "it happens to be
  convenient right now" is how a cancelled request ends up doing work nobody
  will collect.
- **An aborted waiter never consumes a permit.** When the queue drains, a
  cancelled entry is compacted out _without_ taking a permit. Letting it take
  one is a quiet capacity leak: the gate looks one permit emptier after every
  abort, and nothing reports it.
- **`pending` and `isFull` count live waiters only.** A cancel storm cannot
  leave the queue reporting itself full with nothing actually waiting.

The abort listener is detached as soon as a waiter is served, so reusing one
signal across many acquires does not accumulate listeners or make the signal
retain every settled closure.

### Options are validated, not coerced

`capacity` and `queueCapacity` are validated. Before 2.0, `capacity` was read as
`Math.max(1, Number(x) || 1)`, so **`capacity: 0` produced a gate holding one
permit rather than none** — and a gate configured to allow nothing is how you
switch a dependency off, so silently becoming _open_ is the worst direction to
fail in. Both now throw a `TypeError` naming the option.

Two zero values are deliberately still accepted, because they are requests
rather than mistakes:

- `queueCapacity: 0` — refuse immediately instead of queueing.
- `initialTokens: 0` — "start empty and let it refill" is the point of a token
  bucket. It is clamped to `capacity` rather than rejected.

## API

- `acquire()` — Returns a `Promise` that resolves to a release callback when a permit becomes available. If a permit is immediately available, the promise resolves synchronously.
- `tryAcquire()` — Returns a release callback if a permit is available immediately, or `null` if no permit is available.
- `release(count?)` — Releases one or more permits back into the gate and dispatches queued waiters in FIFO order. Returns the number of permits that actually came _back_ rather than being transferred to a waiter, so a caller tracking outstanding work is not told a transferred permit is free.
- `reset(options?)` — Clears queued waiters and optionally restores available permits. Waiters are rejected with a provided reason. Permits held by callers that have not released are **not** restored: `available` is capped at `capacity - active`, so a reset cannot admit a second holder alongside one that is still running. A holder's release returns its permit normally afterwards.
- `capacity` — Total permit count, and a hard ceiling on concurrent holders.
- `available` — Current available permit count.
- `active` — Permits granted and not yet returned. Equals `capacity - available` for this class, because `capacity` is a ceiling. It is counted rather than derived, so that the subclass whose refill can exceed the ceiling still reports honestly — see [ADR 0004](../adr/0004-permit-capacity-ceiling-or-pool.md).
- `pending` — Number of queued waiters, excluding any that have been aborted.
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
