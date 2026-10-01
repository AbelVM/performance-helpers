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

| `err.code`                          | Raised by                                           | What it means                                                                                                                   | What to do                                                                                                                              |
| ----------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ERR_POOL_QUEUE_FULL`               | `postMessage` / `postMessageBatch` / `stopThePress` | The task queue is at `options.maxQueueLength`. The incoming task did not fit.                                                   | **Shed load.** Return a 429, drop the request, or apply backoff. Retrying immediately re-sends the same task into a full queue.         |
| `ERR_POOL_DRAIN_TIMEOUT`            | `drain({ timeout })`                                | The pool did not become idle within `timeout` ms.                                                                               | **Retry or give up.** Something is still running — inspect `getStats().activeTasks` and the per-worker `tasks` counts to find out what. |
| `ERR_POOL_DRAIN_TOO_MANY_WAITERS`   | `drain()`                                           | `options.maxDrainWaiters` drains are already waiting.                                                                           | **Stop draining.** You are draining in a loop, which is the bug this bound exists to catch. Drain once and share the result.            |
| `ERR_POOL_DUPLICATE_CORRELATION_ID` | `postMessageBatch`, `postMessage`                   | Two requests claim the same `correlationId`.                                                                                    | **Fix the id generator.** Nothing was dispatched, so no state needs unwinding — this is a naming collision, not a runtime failure.      |
| `ERR_POOL_WORKER_TERMINATED`        | `postMessage` / `postMessageBatch` (Promise form)   | The worker that owed this response was retired — by `resize()`, idle reaping, autoscale, or `stopThePress` — before it replied. | **Retry elsewhere, or give up.** The work is lost, not delayed. Any handler that ran on the worker is gone with it.                     |
| `ERR_POOL_TERMINATED`               | any dispatch method                                 | The pool has been shut down.                                                                                                    | Do not retry. Create a new pool.                                                                                                        |

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
    case 'ERR_POOL_WORKER_TERMINATED':
      // The task was dispatched and is now lost with its worker. This is not
      // a refusal like QUEUE_FULL - the work was accepted - so it is
      // "retry" or "fail", never "shed load".
      throw new RetryableServiceError();
    default:
      throw err;
  }
}
```

`ERR_POOL_WORKER_TERMINATED` is the one to be careful about, because it is the only code that means **the work was accepted and then lost**. A worker retired by `resize()`, idle reaping, autoscale or `stopThePress` takes its in-flight tasks with it, so nothing will ever answer those `awaitResponse` promises. The pool rejects them the moment the worker goes rather than letting them sit until `awaitResponseTimeout` — and under `awaitResponseTimeout: Infinity` there is no timeout, so before this the promise simply never settled. Treat it as a lost task: retry on another worker, or surface the failure, but do not read it as the pool shedding load.

Two of these codes are worth calling out as _good news_: `ERR_POOL_DUPLICATE_CORRELATION_ID` from a batch is thrown **before anything is dispatched**, so a collision cannot leave half the batch on the wire and the other half orphaned. And `ERR_POOL_DRAIN_TIMEOUT` / `ERR_POOL_DRAIN_TOO_MANY_WAITERS` abandon only the _wait_ — the pool keeps dispatching and keeps serving every other caller, so treating them as fatal to the pool is a mistake.

See [Bounding the queue](powerPool.md#bounding-the-queue) for how to produce the first one deliberately, and the `drain()` entry in [PowerPool's API](powerPool.md#api) for the second and third.

## Codes outside the pool

The table above is deliberately exhaustive about the pool, because a refusal you
retry is a queue that fills faster. The codes below are the rest of the library's
branchable errors — and unlike the pool's, they had **no index at all** until now,
even though the per-helper guides already told you to branch on them. If you had
gone to `guides/powerCircuit.md` and been told to check `err.code === 'ECIRCUITOPEN'`,
nothing collected that fact.

| `err.code`               | Raised by                                            | What it means                                                                                                | What to do                                                                                                                             |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `EABORT`                 | `PowerLatch.wait`                                    | The latch was aborted via `abort()`, or the `signal` passed to `wait()` was aborted.                         | Do not retry — a barrier that was aborted will not re-count. Rebuild the latch if you need a fresh barrier.                            |
| `EDISPOSED`              | `PowerLatch.wait`                                    | The latch was disposed before this waiter resolved.                                                          | Do not retry. The latch is unusable; construct another.                                                                                |
| `ETIMEOUT`               | `PowerLatch.wait({ timeout })`, `PowerRetry` attempt | A wait or a single retry attempt exceeded its `timeout`.                                                     | **Retry or give up** — the work may or may not have completed; only the wait is bounded.                                               |
| `EDEADLINE`              | `PowerDeadline.run`                                  | The overall deadline elapsed. Carries `attempts` and `elapsedMs` alongside the code.                         | **Give up on the operation.** Do not retry; a whole-operation budget that ran out will run out again.                                  |
| `ECIRCUITOPEN`           | `PowerCircuit.call`                                  | The circuit is open, so the call was short-circuited **without being attempted**.                            | **Do not retry immediately** — that is what reopening suppresses. Fall back, or wait for the `closed` transition.                      |
| `ERR_BULKHEAD_RESET`     | `PowerBulkhead.reset({ reason })`                    | Queued work was released by `reset()` rather than completing. A caller-supplied `reason` keeps its own code. | Treat as a cancellation. Anything that assumed the work ran needs to know it did not.                                                  |
| `ECHUNKDISPATCH`         | `PowerChunker`                                       | One or more chunks could not be dispatched to the pool. Carries `failedChunks`, `mode` and `cause`.          | **Retry the failed chunks only.** `failedChunks` names which; the rest were dispatched and must not be resent.                         |
| `ERR_WS_CONNECT_TIMEOUT` | `PowerWebSocketClient`                               | The socket did not reach `OPEN` within `connectTimeoutMs`.                                                   | **Retry the connect**, optionally with backoff. The client is left `CLOSED`, not half-open.                                            |
| `ERR_QUEUE_FULL`         | `PowerPermitGate.acquire`, `PowerBulkhead.run`       | A bounded queue is full, so the call was refused rather than queued. Carries `queueCapacity`.                | **Shed load.** Same response as `ERR_POOL_QUEUE_FULL` — 429, drop, or back off. Retrying into a full queue is the load that filled it. |
| `ERR_ITEM`               | `normalizeError(err)`                                | A **fallback**, not a real code: applied when the error being normalised carried none.                       | Do not branch on it. It means "this error was anonymous", not "this specific thing went wrong".                                        |

Three of these are genuinely indistinguishable from each other if you only look at
`err.name`, which is why they exist as codes:

- `ETIMEOUT` bounds **one attempt** or **one wait**; `EDEADLINE` bounds the
  **whole operation**. Both are "time ran out", and retrying under `ETIMEOUT` is
  reasonable while retrying under `EDEADLINE` is usually not.
- `EABORT` is the _caller's_ decision to stop; `EDISPOSED` is the _object's_ — a
  latch disposed underneath a waiter. Both reject a pending `wait()`, and the
  second is a bug in your teardown order if you did not expect it.
- `ECIRCUITOPEN` means the call was **never attempted**. A failure count of zero
  for that request, which is why it must not be counted as a failure upstream.

`ERR_QUEUE_FULL` deliberately reuses the pool's `ERR_POOL_QUEUE_FULL` _condition_
rather than introducing a new spelling of it. Three classes refusing the same
capacity for the same reason is one branch for a caller to write, not three; a
caller who already handles the pool's code gets the right response here for free.

`ERR_ITEM` is the odd one out and is listed only so it is not mistaken for a real
condition: `normalizeError` assigns it when the error it is given carried no code,
so it means "unattributed". Branching on it is a category error.

`ERR_BULKHEAD_RESET` and `ECHUNKDISPATCH` carry structured fields
(`reason`, and `failedChunks` / `mode` / `cause` respectively). Prefer those over
parsing the message — the message text is not part of the contract, the code and
its fields are.
