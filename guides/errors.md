# Errors and failure-handling patterns

This guide describes recommended error shapes, common patterns used across the helpers in this repository, and best practices for attaching diagnostic information such as durations, worker ids, and correlation ids.

## Error shapes

- Prefer plain `Error` or subclasses with stable properties: `name`, `message`, `stack`.
- Attach structured diagnostic properties rather than encoding them into the message string. Common fields used in this repo: `duration` (ms), `workerId`, `correlationId`, `status` (HTTP-like numeric code).

Example:

```js
const err = new Error('request failed');
err.duration = 123.4;
err.workerId = 'w-3';
err.correlationId = 'abc-123';
throw err;
```

## Measuring and attaching durations

Helpers such as `measureAsync()` attach a `durationMs` property to thrown errors so callers can log or make decisions based on how long the failing operation ran. When catching errors prefer to check `typeof err.durationMs === 'number'` before trusting the value.

## Correlation ids and pending responses

When using the pool's Promise-based `postMessage(message, undefined, { awaitResponse: true })` API, the pool attaches a `correlationId` to the outgoing message and tracks pending responses. The same `correlationId` will normally be present in the worker response. If you implement your own worker handlers, echo `correlationId` back inside the response payload so the pool can resolve the proper Promise.

Note the three arguments. `options` is the **third** parameter, after `transfer`, so the two-argument shorthand `postMessage(msg, { awaitResponse: true })` does not work: the object lands in the `transfer` slot and the call fails with `TypeError: tr is not iterable`, which names neither the argument nor the mistake.

Worker-side example:

```js
import { decodeMessage } from 'performance-helpers';

self.onmessage = (e) => {
  // PowerPool frames its messages by default (2.0+).
  const data = decodeMessage(e.data).value;
  // ... process ...
  self.postMessage({ correlationId: data.correlationId, response: result });
};
```

If your pool still runs with `messageCodec: 'legacy'`, use `u82o(e.data)` here instead. See
[Migrating to the framed protocol](powerPool.md#migrating-to-the-framed-protocol-breaking-change-in-20).

## Best practices for logging

- Log structured JSON when integrating with centralized logging or pipeline tools. `PowerLogger` supports a JSON mode in the library; prefer that in production.
- Avoid swallowing errors silently; if you must, log them at `debug` level with `PowerLogger` so they are available under higher verbosity during troubleshooting.

## Pool refusal codes

Some `PowerPool` failures are not exceptions thrown at you — they are _refusals_, and the pool signals them with a stable `err.code` so you can branch on them without string-matching a message. Every code below means **the pool is healthy; it declined this particular piece of work**, and the right response differs for each one. Treating them as generic errors and retrying blindly is the common mistake: retrying a `QUEUE_FULL` refusal is precisely the load that filled the queue.

| `err.code`                          | Raised by                                           | What it means                                                                 | What to do                                                                                                                              |
| ----------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ERR_POOL_QUEUE_FULL`               | `postMessage` / `postMessageBatch` / `stopThePress` | The task queue is at `options.maxQueueLength`. The incoming task did not fit. | **Shed load.** Return a 429, drop the request, or apply backoff. Retrying immediately re-sends the same task into a full queue.         |
| `ERR_POOL_DRAIN_TIMEOUT`            | `drain({ timeout })`                                | The pool did not become idle within `timeout` ms.                             | **Retry or give up.** Something is still running — inspect `getStats().activeTasks` and the per-worker `tasks` counts to find out what. |
| `ERR_POOL_DRAIN_TOO_MANY_WAITERS`   | `drain()`                                           | `options.maxDrainWaiters` drains are already waiting.                         | **Stop draining.** You are draining in a loop, which is the bug this bound exists to catch. Drain once and share the result.            |
| `ERR_POOL_DUPLICATE_CORRELATION_ID` | `postMessageBatch`, `postMessage`                   | Two requests claim the same `correlationId`.                                  | **Fix the id generator.** Nothing was dispatched, so no state needs unwinding — this is a naming collision, not a runtime failure.      |
| `ERR_POOL_TERMINATED`               | any dispatch method                                 | The pool has been shut down.                                                  | Do not retry. Create a new pool.                                                                                                        |

A refused task that was _not_ awaiting a response returns `false` rather than throwing, so a plain `postMessage` caller sees a falsy return instead of a code. The codes are only observable through the Promise path (`awaitResponse` or an explicit `correlationId`):

```js
// Boolean form - check the return value.
if (pool.postMessage(payload) === false) {
  // queue full or worker busy; this call did not queue anything
}

// Promise form - branch on the code.
try {
  const result = await pool.postMessage(payload, undefined, { awaitResponse: true });
} catch (err) {
  switch (err.code) {
    case 'ERR_POOL_QUEUE_FULL':
      metrics.increment('pool.refused', { reason: 'queue_full' });
      throw new TooManyRequestsError();
    case 'ERR_POOL_TERMINATED':
      throw new ServiceUnavailableError();
    default:
      throw err;
  }
}
```

Two of these codes are worth calling out as _good news_: `ERR_POOL_DUPLICATE_CORRELATION_ID` from a batch is thrown **before anything is dispatched**, so a collision cannot leave half the batch on the wire and the other half orphaned. And `ERR_POOL_DRAIN_TIMEOUT` / `ERR_POOL_DRAIN_TOO_MANY_WAITERS` abandon only the _wait_ — the pool keeps dispatching and keeps serving every other caller, so treating them as fatal to the pool is a mistake.

See [Bounding the queue](powerPool.md#bounding-the-queue) for how to produce the first one deliberately, and the `drain()` entry in [PowerPool's API](powerPool.md#api) for the second and third.
