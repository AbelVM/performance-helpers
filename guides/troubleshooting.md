# Troubleshooting

The failures people actually hit, in rough order of how often they come up. Each
one names the error you will see, explains _why_ it happens, and gives the fix —
including the fix that keeps working when the obvious one does not.

If your error is not here, the
[errors guide](errors.md) covers the shapes the library attaches deliberately,
and every helper's own guide documents its options.

---

## `worker_threads is not available synchronously in pure ESM`

**The single most likely first-run failure.** It only happens in one environment,
which is why it is worth recognising immediately.

```
ERR_ITEM: WorkerAgnostic: Node worker_threads is not available synchronously in
pure ESM. Call `await preloadNode()` (imported from `performance-helpers` or
`performance-helpers/WorkerAgnostic`) once before constructing a string-source
worker, or set globalThis.Worker. A factory function does not need this preload.
Initial worker creation failed
```

The pool wraps the `WorkerAgnostic` error, so the text you will search for is the
whole line including the `ERR_ITEM:` prefix and the
`Initial worker creation failed` suffix.

### Why

In pure ESM Node there is no `require`. Not a missing one, not a hidden one —
the identifier genuinely does not exist in an ES module's scope, and it is not on
`globalThis` either. The pool needs the `Worker` constructor to hand work to, and
it has to reach it _synchronously_, at the moment it decides to spawn a worker. An
ESM module cannot call `require` at all, so the only way to get one is to build it
from `node:module` — and building it is **asynchronous**.

So the pool asks you to do that one async step first, once, before you construct
it.

### Fix — pick whichever fits

**1. `await preloadNode()` once at startup.** The explicit, portable answer, and
the one the error message names:

```js
import { PowerPool, preloadNode } from 'performance-helpers';

await preloadNode(); // resolves createRequire from node:module, once

const pool = new PowerPool('./worker.js'); // string source now works
```

**2. Pass a factory function instead of a string.** This is the better fix when
you can, because it needs no preload and no global:

```js
const pool = new PowerPool(() => new Worker(new URL('./worker.js', import.meta.url)));
```

A factory defers module resolution to the worker file's own imports, so the pool
never needs `require` itself. **If you are writing this library's own tests or
your worker does not need a string source, prefer this one** — it removes a step
rather than satisfying it.

**3. Set `globalThis.Worker`.** If you already resolved the constructor for
another reason:

```js
import { Worker } from 'node:worker_threads';
globalThis.Worker = Worker;
```

Fine, but note it is a **global** mutation: it affects every library in the
process that looks for `Worker`. Prefer 1 or 2 in shared code.

### What you do _not_ need to do

- **This is not an ESM-vs-CommonJS problem with the package.** It is not about
  how _you_ import, and it is not about `package.json` `type`. It is about
  `require` not existing in ESM scope at all.
- **CJS and transpiled environments never hit this** — vitest, ts-node with
  `module: commonjs`, a plain `require`d build. If you are seeing it there, you are
  running real ESM, and the fix above is still the right one.
- **Browser builds never hit this.** The browser path uses `Worker` directly.

---

## The worker received a framed message but expected a plain object

```
TypeError: PowerMessageCodec: expected a Uint8Array, ArrayBuffer or DataView
```

### Why

Since 2.0, `PowerPool` defaults to `messageCodec: 'framed'`: outgoing messages
are encoded by
[PowerMessageCodec](powerMessageCodec.md) and carry a small header — codec id,
payload length, then the payload. A worker written against the old behaviour and
doing `self.onmessage = (e) => doWork(e.data)` now receives a `Uint8Array` where
it expected your object.

The worker's `e.data` is now a `Uint8Array` carrying a small header — version,
codec id, payload length, then the payload — instead of your object. The framing
is what lets a worker tell an object message from a binary one, and it is what
makes the pool's protocol self-describing. The trade is that both sides have to
agree, and a worker that skips the decode step gets a confusing error rather than
a missing field, because the object it was handed is a byte array.

### Fix — decode on the worker side

```js
// worker.js
import { decodeMessage } from 'performance-helpers/powerMessageCodec';

self.onmessage = (e) => {
  const { value } = decodeMessage(e.data);
  self.postMessage({ ok: true, result: handle(value) });
};
```

`decodeMessage` returns `{ version, codec, value, byteLength }` — take `value`,
and treat the rest as the header it is. It is the only thing that should ever
touch the raw `e.data` in a framed pool.

### If you genuinely cannot change the worker

Set `messageCodec: 'legacy'` on the pool and your existing worker keeps working:

```js
const pool = new PowerPool('./worker.js', { messageCodec: 'legacy' });
```

**Read the cost before you do.** Legacy mode means no codec header, so the worker
cannot distinguish an object message from a binary one, and the pool's
self-describing protocol is gone. It is an escape hatch for an unmigrated
worker, not a peer to the default.

---

## Everything works until the first burst, then nothing is served

**Symptoms:** the pool reports `activeTasks` stuck above zero, `drain()` never
resolves, or the working set is empty and the queue is full.

### The most common cause is a capacity that cannot hold what you are feeding it

This is not a bug in the library — it is a configuration that is correct on paper
and wrong in practice. A cache or pool whose capacity equals the _working set_
size has no headroom for the scan traffic that comes with real traffic, so every
one-off key evicts something you needed.

**Check the two numbers separately:** how many entries the working set actually
has, and how much of the request stream is one-off. Then give the container
headroom, or — for the cache — turn on `admission: 'tinylfu'` and read
[the admission guide](powerCache.md) first, because that option is currently
**not** recommended: it measures worse than plain LRU on a cold cache (see the
2.0 release notes).

### If it is `drain()` specifically

`drain()` resolves when the queue is empty and no task is in flight. If it never
resolves, one of those is untrue — usually because a worker was terminated while
holding a task, or because a task you posted was never actually served. Read
`getStats()`: `activeTasks` and the per-worker `tasks` counts tell you which.

---

## `ERR_POOL_QUEUE_FULL`

Not an exception you should normally see: it means the task queue is at
`maxQueueLength` and the arriving task did not fit. Set a `maxQueueLength`, or
reduce the arrival rate — see
[Bounding the queue](powerPool.md#bounding-the-queue).

**`ERR_POOL_QUEUE_FULL` is a load-shedding signal, not a retry signal.** Retrying
immediately re-sends the same task into the same full queue.

---

## A `BroadcastChannel` hangs the process, or a slow receiver eats all your memory

Two properties of the platform that bite in Node, both measured here.

**An open channel keeps the event loop alive.** A `Worker` `MessagePort` and
`BroadcastChannel` are both started handles, and Node does not exit while either
is open. A three-line script with one `new BroadcastChannel` and one `postMessage`
runs until you kill it:

```js
const bc = new BroadcastChannel('x');
bc.postMessage('hello');
// the process does NOT exit
bc.unref(); // now it does
```

This is the same shape as the pool's own `MessageChannel` bug and the reason
[PowerScheduler](powerScheduler.md) `unref()`s its module-level channel. In a
browser there is no event loop to hold open, so it is Node-only.

**There is no backpressure.** `BroadcastChannel` has no `bufferedAmount`, no
`readyState`, no `desiredSize`, and `postMessage` returns `undefined`. The queue
is invisible and unbounded: posting 400 000 × 1 kB messages at a receiver doing
1 ms of work per message drove RSS to **203 MB** with no signal and no throw. The
**only** transports in this library that can report pressure are the WebSocket
family (`bufferedAmount`) — a `MessagePort` does not report it either.

**Transfer lists are silently ignored.** `postMessage(msg, [arrayBuffer])` is
accepted and does nothing: the buffer is copied rather than transferred, and no
error is raised. `MessagePort.postMessage` genuinely transfers (the sender's
`byteLength` drops to `0`). So an adapter written against
`frameTransferList()` from `PowerMessageCodec` will look like it transfers, will
not throw, and will pay a full copy.

**If you need this, you do not want this class.** `PowerRealtimeHub`'s
per-subscriber queues and slow-consumer policies are what bound a fan-out, and a
`BroadcastChannel` cannot carry them — its `send` adapter must return a promise
and `postMessage` returns `undefined`. `guides/powerEventBus.md` has the same
conclusion for cross-context eventing.

---

## "Should the pool use `SharedArrayBuffer`?"

No, and the reason is a measurement rather than a preference — so this section exists to
stop the question being re-asked with a new rationale each time. Run it yourself:
`node bench/claims.js permit`.

`PowerPool` gates every dispatch with `tasks < this._maxTasksPerWorker`: a plain field
read. A shared-memory permit pool makes the same decision through an atomic. Measured over
2 000 000 operations:

| operation                | cost     | vs the field read |
| ------------------------ | -------- | ----------------- |
| plain field read (today) | 1.91 ns  | —                 |
| `Atomics.load`           | 12.02 ns | **6.3×**          |
| `Atomics.add`            | 11.04 ns | **5.8×**          |

A proposal once called this "the one change that could move the pool's floor cost". It is
6.3× **more** expensive than the field read already in the path.

**The blocking mechanism is the harder no.** `Atomics.wait` parked the thread for its
full timeout — 1054 ms for 1000 × 1 ms waits — and it is forbidden on a browser main
thread and requires cross-origin isolation. `PowerSemaphore` documents itself as an async
gate that does not block the event loop, so the one mechanism that would block is the one
you would have to use. `Atomics.waitAsync` does not block, which means it is a timer, and
a timer adds nothing an async queue does not already do (0.9 ms for the same 1000 waits).

**When it would be worth it**, if you are building the browser app rather than using this
library: a large, string-heavy per-message payload — the measurement puts the crossover at
roughly **32 KB**, where gzip's ratio flattens out at about 0.08 — **and** you control your
own headers, so you can serve `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. Without those headers `SharedArrayBuffer` is
not merely slow, it is absent.

**When it is definitely not worth it**, which is most of the time:

- **Node.** The permit decision is 6.3× more expensive and there is no shipping blocker
  to trade against.
- **Small payloads.** Below the ~32 KB crossover there is nothing to save; above it,
  compression is the wrong tool for a thread boundary anyway. `node bench/claims.js
payload`: at 652 781 bytes gzip costs **1207 µs** in the sender to save 92 % of the
  bytes, brotli costs **419 ms**, and simply _transferring_ the same payload rather than
  copying it costs **29.1 µs** — which the pool already does. There is no size at which
  compression pays, because a `Worker` port does not charge per byte.
- **Deeply nested payloads.** Carrier overhead scales with structure, not bytes — see
  `node bench/claims.js carrier`.

If you have measured your own workload and the pool is genuinely the bottleneck, that is a
real result and it belongs in an ADR. What does not belong is re-deriving the ratio above.

---

## A scheduled job drifts, or fires several times at once

If you reached for `setInterval` — that is the usual cause, not this library.
`setInterval` means "every N ms after the previous callback _returns_", so a run
that overruns pushes every later fire and a stalled run **queues**. Use
[PowerCron](powerCron.md), which re-arms from an absolute target and skips the
periods it missed.

---

## Still stuck?

1. **`getStats()` first.** Most "the pool is broken" reports are answered by
   `activeTasks`, `queueLength` and the per-worker `tasks` counts.
2. **Turn on debug logging.** `new PowerPool(Worker, { debugLevel: 3 })` — see
   [PowerLogger](powerLogger.md).
3. **Check your worker actually posted something.** A worker that throws, or
   returns without `postMessage`, leaves the pool waiting for a reply that will
   never come. The pool's timeouts are what surface this; they are not the bug.
