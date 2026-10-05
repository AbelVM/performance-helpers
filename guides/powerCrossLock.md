# PowerCrossLock

A fair mutex shared by every worker in the process, over the platform's Web Locks
implementation.

```js
import { PowerCrossLock } from './helpers/powerCrossLock.js';

const lock = new PowerCrossLock();
await lock.run('cache:warm', async () => {
  // No other worker or thread can be inside this block for this name.
  await warmTheCache();
});
```

`PowerSemaphore` limits concurrency **inside one thread**, and every instance is
independent, so two workers each get their own permits. `PowerCrossLock` is the other
half: one lock, one queue, FIFO, visible to every worker and every thread in the
process — and to any other process, because the lock lives in the platform's lock
manager rather than in this library.

## What it is, and what it is not

The lock manager is in Node (24.x), in Chromium and in Firefox. It is **not** gated on
`crossOriginIsolated`, which is why this helper needs no SharedArrayBuffer fallback —
unlike `SAB-003` and `SAB-004`, which exist only because browser task priorities do.

`run()` is **callback-scoped** rather than returning a release function. The obvious
missing method was a handle-returning `acquire`, and a manual release is the wrong shape for a lock shared across worker boundaries: a caller that
forgets it wedges _every other worker_ for the life of the process, with no error and no
local state to inspect. Scoping the lock to the callback makes the release unconditional
— a throw, a rejection and a `return` all release it, because the platform holds the lock
across the callback's promise rather than across a line of the caller's code.

## There is no try-acquire, and that is a measurement

The obvious missing method is a non-blocking "take it if free", and the obvious
implementation is the platform's `ifAvailable` option. **On Node 24.18 `ifAvailable` is
a no-op**: it never refuses. Measured with a section queued behind a held lock, the
section **ran** — and it also ran when the holder was in a different thread, so this is
not a same-client quirk:

```
lock held, ifAvailable: true, same thread   ->  section ran
lock held, ifAvailable: true, other thread  ->  section ran
```

So a non-blocking helper could only have been built on `query()`-then-`request()`, which is
**not atomic** — the lock can change hands between the two calls — and a best-effort answer
presented as a guarantee is precisely the silent substitution this library rejects
elsewhere. The method is **absent rather than approximated**, and
`waiterCount()` is the honest way to ask whether a name is busy.

## `query()` is per-thread

The plan row implied this method saw cross-worker state, and **it does not**. Measured
on Node 24.18 with a lock held in a `Worker`: the main thread's `query()` reported
`held: []`, and the worker's own `query()` reported the lock. So `query()` answers "what
is _my_ thread doing here", not "who has this lock in the process".

That is a real limitation and it is the reason this method is documented rather than
promoted: it is still useful — it is the only way to see whether _you_ are blocked and on
what name — but a caller who wants to know whether **another** worker is holding a lock
has to look at their own code, because the platform does not expose that. The
cross-worker guarantee rests on `request()` alone, which is atomic and shared.

## `steal` is not a polite hand-over

`steal: true` is opt-in per call rather than an instance default, and for a measured
reason. With one holder inside `request()` and a second `request(name, {steal: true})`:

- the second callback runs;
- the **first holder's `request()` promise rejects** with `DOMException [AbortError]`
  (`code: 20`);
- the first holder's callback **does not stop** — its work runs to completion while the
  lock is free to everyone else.

So `steal` means _release now and tell the old owner it lost_. Two things a caller has to
design around: the stolen holder **cannot tell a steal from its own signal** (the
`AbortError` carries no lock name and no own properties — checked), and the code the
previous owner was inside keeps running against whatever invariant the lock was
protecting. Make the critical section idempotent before using `steal`.

## A leak that the callback shape fixes

**Measured on Node 24.18.** When the callback passed to `LockManager.request` throws
**synchronously**, the lock is **never released** — the promise rejects with the thrown
error, and every later request for that name waits forever:

```
callback throws synchronously   ->  lock PERMANENTLY HELD
callback rejects asynchronously  ->  lock released
callback returns a value        ->  lock released
```

The boundary is independent of arity — `request(name, fn)` and `request(name, {}, fn)`
leak identically. `run()` wraps the callback in `async () => fn()`, which converts the
throw into a rejection, the path that does release. The consequence of not fixing it is
the worst shape available: the caller's own error surfaces correctly, so the failure looks
handled, while that lock _name_ is wedged for the life of the process with nothing to
indicate why.

## Counters, not durations

`stats()` reports `supported`, `acquisitions`, `steals`, and `aborted`. There is no
`waits` counter, and its absence is deliberate: the obvious way to count contention is to
ask the lock manager whether the name is already held, but that is an async round trip
that cannot be atomic with the acquisition that follows it, and reading it costs a round
trip on every `run()` purely to fill in a diagnostic. Contention is measured from the
platform instead, where it is authoritative: `waiterCount()` and `query()`.

## Disposal

`dispose()` is a **state reset**, not a teardown — no timer, no listener, no queue of
this library's own — and the lock manager's own locks are deliberately left alone: another
instance may be mid-section. It is idempotent and safe while idle, so the instance works
with `using`.
