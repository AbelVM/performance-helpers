---
'performance-helpers': patch
---

### Added

`PowerPool`'s `ready` option — a worker readiness gate.

```js
const pool = new PowerPool(WorkerScript, { ready: true });
// in the worker:
postMessage({ ready: true }); // once async setup is done
```

Without this, a task can be dispatched to a worker still running its constructor's async
work. The worker receives the message, cannot answer it, and the caller waits for a
response that will never come — which surfaces as a timeout rather than as a failure to
start.

- **The field name is yours.** Pass a string to name it (`ready: 'initialised'`), or
  `true` for the default `'ready'`. A worker posting `{ ready: true, version: 3 }` has
  signalled; the extra fields are ignored. A bare `true` works too.
- **The signal is pool-internal traffic.** It is consumed by the pool and deliberately
  _not_ forwarded to `message` listeners, which never sent it and would have to
  recognise it to be correct. It is also not a task, so it does not touch the task
  accounting.
- **`readyTimeout` fails open.** A worker that never signals is dispatched anyway after
  that many ms, so a misbehaving worker degrades to the old behaviour rather than
  wedging the pool forever. `0` (the default) waits forever.

**What happens to a post that arrives while nothing is ready.** With the task queue on —
the default — the work is _held_, not refused: the caller is not told "no" for a
condition that resolves in milliseconds. With `taskQueue: false` and no ready worker, the
post is refused instead, because the round-robin fallback would otherwise dispatch
straight past the gate.

### Tests

13 tests in `test/powerPool.readiness.test.js`, mutation-checked 5 of 5 — including
reverting the single-worker fast path, which is where the first draft of the
implementation was wrong.

Two things about that first draft are worth recording. `singleWorkerDirectFastPath`
resolves `least` to `this.workers[0]` directly and never reaches `_selectWorker()`, so
with `size: 1` the gate was bypassed entirely — measured, a `size: 1` pool with
`ready: true` delivered the first post to a worker whose `ready` was still `false`. And
the ready signal was matched on `data` _before_ the codec's decode block, so it matched
nothing: the codec wraps a payload as `{ version, codec, value, byteLength }`, and
`data.ready` was `undefined` for every real signal.

Two of the tests also started from a wrong premise and were corrected rather than
loosened. The first asserted a _refusal_ when nothing is ready, but the pool queues —
which is better, and the reason the refusal tests now need `taskQueue: false` to reach
the path they mean to test.
