---
'performance-helpers': minor
---

Closes two features on a measurement rather than a guess, and adds the
benchmarks that did it.

Both rows carried a precondition — "needs a large-payload bench to justify",
"the one change that could move the pool's floor cost" — and neither had been
run. Now they have, and both premises turned out to be wrong.

**FEAT-013 (compression on the message path) is not built.** `node bench/claims.js payload`:

> A `Worker` port is not a wire. The threads are in the same process — no
> network, no serialisation link, no bandwidth to save. `postMessage` already
> moves a large payload by _transferring_ its `ArrayBuffer`, and the pool
> already offers that path.

At 650 KB, gzip costs **1183 µs** in the sender to save 92% of the bytes, and
brotli costs **417 ms**; transferring rather than copying costs **30 µs**, and
the pool already does that. At 596 bytes brotli costs 653 µs for a 596-byte
message, because the cost is not proportional to the saving. `CompressionStream`
— the web API the row named — is _worse_ than the one-shot API, at 7692 µs
against 230 µs for the same payload: a stream carries fixed per-call overhead,
which is the wrong shape for a message where the whole payload is in hand at
once. There is no size threshold that makes this pay.

It would pay on a link that charges per byte — a `WebSocket`, `fetch`, or a
worker on another host. `PowerMessageCodec`'s framed byte-stream mode already
covers those, and `bench/claims.js` already demonstrates reading frames off a
stream.

**FEAT-011 (a `SharedArrayBuffer` permit pool) is not built.** `node bench/claims.js permit`:

> `PowerPool` gates every dispatch with `tasks < this._maxTasksPerWorker` — a
> plain field read at **1.82 ns/op**. A shared-memory permit pool makes the same
> decision through an atomic: `Atomics.load` at **11.65 ns/op**, `Atomics.add` at
> **11.23 ns/op**.

That is 6.4× more expensive at the one place the pool would consult it, and the
pool's floor cost is worker creation and message transport rather than permit
accounting. The blocking half is worse: `PowerSemaphore` documents itself as an
async gate that does not block the event loop, and 1000 `Atomics.wait` calls of
1 ms measured **1055.7 ms** — it parks the thread for its full timeout, exactly
the behaviour that exists to be avoided. `Atomics.waitAsync` does not block, so
it is a timer and adds nothing an async queue does not already provide. And
`Atomics.wait` is forbidden on a browser main thread while `SharedArrayBuffer`
needs cross-origin isolation, so the feature would work in Node and be silently
unavailable on the web.

The capability itself is not unreasonable — a global cap across a fleet is
already `size × maxTasksPerWorker`, enforced centrally. Sharing a budget across
_independent_ workers is a real need, but it is a new helper with a new API,
specified from a use case rather than from a mechanism.

**TEST-006 is complete.** Both halves are done: the counter-based guard
(operation counts, machine-independent) and the timing gate, whose threshold is
derived from a measured per-machine spread rather than chosen in advance. It
reports `PASS`, `FAIL` or `INCONCLUSIVE`, and inconclusive is never a failure —
so a busy machine cannot produce a red build. A `FAIL` re-measures before
reporting, because a single GC pause is not a regression. It is
mutation-checked: a deliberate constant-factor slowdown in `PowerCache.get` is
caught and reproduced, and a clean tree is not.
