# 0004. `capacity` is a ceiling on some gates and a pool size on others

**Status:** Accepted
**Affects:** `PowerPermitGate`, `PowerSemaphore`, `PowerBulkhead` (ceiling); `PowerBackpressure` (pool)

## Context

`PowerPermitGate` has one number, `capacity`, and it is inherited by
`PowerSemaphore`, `PowerBulkhead` and `PowerBackpressure`. Fixing the in-flight
accounting in that class — `RES-003`, `RES-024` — turned `capacity` from an
incidental part of the arithmetic into a load-bearing question with two
defensible answers, and the code had to pick one without saying so.

The question is what a permit _is_, and it is not the same in all four classes:

- In `PowerSemaphore`, a permit is a concurrent slot. `new PowerSemaphore(3)`
  means "at most three of these at once", and a caller holding one has a claim on
  it that only `release()` or `reset()` can end.
- In `PowerBackpressure`, a permit is a token drawn from a pool the refill
  replenishes. The refill exists to relieve a queue of waiting producers, and it
  does that by minting. If a permit were a claim on a fixed number of slots, the
  refill could never grant anything: a producer only queues when the pool is
  empty, an empty pool means every permit is out, and "missing" is then always
  zero. `refillAmount`, `refillInterval` and the whole AIMD window would be dead
  code.

The second reading is not a nicety. The guide's own description of the mechanism
— "base number of permits **restored** during each adaptive refill", "when
available permits fall below this threshold, adaptive refill begins" — is the
token-bucket reading. The ceiling reading is what `tryAcquire()` and `isLocked`
describe, and it is what `PowerSemaphore` needs.

## Decision

Both readings are kept, and each class is on the one its name implies.
`capacity` is:

- a **ceiling** on concurrent holders for `PowerPermitGate`, `PowerSemaphore`
  and `PowerBulkhead`;
- the **pool size** the refill draws from for `PowerBackpressure`.

The two facts that make this coherent rather than a contradiction are recorded
here, because both were bugs first:

**1. `active` counts holders, it is not `capacity - available`.**
`active` reads `_held` — permits granted and not yet returned. The two agree
exactly whenever `capacity` is a ceiling, so the change is invisible for the
semaphore and the bulkhead. Under the pool model they diverge, and the old form
cannot represent the divergence: `capacity - available` cannot exceed
`capacity`, so on a `PowerBackpressure` whose consumers are not returning their
permits it sits pinned at the ceiling and reports a healthy gate while the work
is piling up. A saturation-capable metric is the wrong metric for a quantity that
is _expected_ to exceed its nominal bound.

**2. `reset()` will not refill the pool past what is outstanding.**
`available` is clamped to `max(0, capacity - held)`. Outstanding holders cannot be
settled by a reset — the promise that produced a release callback has already
resolved, so there is nothing left to reject — but a teardown can and must stop
pretending their permits are free. Before this, `reset()` on a gate of 1 with one
`run()` in flight produced a _second_ concurrent holder against a limit of 1,
permanently, because the first holder's release was then absorbed by the capacity
clamp. `using sem = new PowerSemaphore(1)` is enough to reach it.

Under-admitting on a teardown is the safe direction for both models, which is why
one clamp serves both.

### The heartbeat is load-bearing, and was not

A consequence of the pool reading that was not obvious while writing it: **the
refill drains the queue it exists to relieve.** A producer only queues when the
pool is empty; a tick mints; the queue empties. So the queue is a _transient_ —
present for roughly one tick — and anything gated on "is anyone waiting?" is
gated on something that is usually false.

That turned out to include the AIMD controller's own heartbeat.
`_adaptiveHeartbeat` means "keep probing", but the only thing that armed a refill
timer was a producer arriving to find an empty pool, and after the first tick
there is no pool and no arrival. Measured with 16 producers against a capacity of
8, each holding its permit: **two** `_aimdStep` calls in 400 ms, the window cut
`8 → 4 → 2` with a floor of 1, and then frozen at 2 for the rest of the object's
life with 16 permits outstanding and `_refillTimer` null. The signal was honest
after `RES-003`/`RES-024` and the controller was still asleep.

So the heartbeat now arms the timer itself, which restores the loss signal's
meaning. Two things keep that affordable:

- **`adaptive` defaults to `false`.** The heartbeat only exists for a caller who
  asked for adaptation, and that caller's expectation is that the option works.
- **It terminates.** `_performRefill` clears the flag when there is no queue
  _and_ nothing in flight, so the controller probes while there is work to
  observe and stops when the gate goes quiet. Without this the fix buys a timer
  that runs for the object's lifetime, learning only that the window should grow.

The alternative — making `capacity` a hard ceiling so the signal is correct by
construction — was rejected for the reason given above: a ceiling makes `missing`
structurally zero, which deletes the refill. That was already the rejected
alternative here, and this finding is the second argument for it.

## Consequences

- `PowerSemaphore` and `PowerBulkhead` behaviour is unchanged except that a reset
  no longer over-issues. `capacity - available === _held` for them, always.
- On `PowerBackpressure`, `active` can exceed `capacity`. This is visible, and
  `examples/backpressure.mjs` prints the case rather than hiding it.
- A release that serves a queued waiter is a **transfer**, not a return: the
  permit is never in the pool in between, so the outstanding count is invariant
  across it. This is why `release()` returns what actually came _back_ rather
  than what was asked for, and why the AIMD signal used to be pinned in additive
  increase — it subtracted on the transfer path.
- The AIMD congestion test is `in-flight >= capacity`, which remains meaningful
  under the pool model: crossing the pool size is the signal, and the window is
  what corrects it.
- Two things are now _not_ claimed, which the old code and guide both implied:
  that `_inFlight` is bounded by `capacity`, and that a refill can always
  relieve a queue. It cannot relieve a queue whose every permit is out and
  never coming back. That is the pressure the class exists to express.

## Alternatives considered

**Make `capacity` a ceiling everywhere, and make the refill restore only
permits that were consumed.**
Rejected, and it is the reading this ADR was written to prevent arriving as a
bug report. It is internally consistent, and it deletes the feature: with a
ceiling, a queued producer implies saturation, so `missing` is structurally zero
and `refillAmount` / `refillInterval` / `adaptive` do nothing at all. The class
would become `PowerSemaphore` with three inert options. The test for whether a
mechanism is real is whether you can delete it without noticing — here you cannot,
which is the point.

**Make `capacity` a pool size everywhere.**
Also rejected. `PowerSemaphore(3)` would then be a starting token count with no
ceiling, `isLocked` and `tryAcquire` would lose their meaning, and the review's
`RES-023` — a reset admitting a second holder against a limit of one — would
become correct behaviour. The semaphore is a concurrency limiter; that is its
whole reason to exist separately from the backpressure controller.

**One number, and a separate `maxConcurrent` option for the pool case.**
Rejected as a naming problem, not a modelling one. The two classes would grow
near-identical options with different names and one shared counter, and the
question "which of these does my `capacity` mean" would become answerable only
by looking up the class. ADR 0003's test applies: a reader should act
differently after reading this, and the action here is "check which class you
are in", not "check which option you passed".

## Where this is visible

`guides/powerBackpressure.md` is the reference, and its claim that
"`_inFlight` is bounded by `capacity`" was **wrong** — written as an aspiration,
believed because the counter that would have falsified it was incremented on one
of three grant paths. `examples/backpressure.mjs` prints the divergence.
`review.md`'s `RES-003`, `RES-024`, `RES-023`, `RES-028`, `ALGO-005`, `ALGO-010`
and `RES-008` all sit on this; the first four are fixed here, and the last three
depend on it.
