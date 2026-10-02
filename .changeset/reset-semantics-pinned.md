---
'performance-helpers': patch
---

**Pins what `reset()` means on each of the 19 classes that have one.** No
behaviour changes — this is a characterisation of decisions that were already
made and already documented.

`reset()` does not mean one thing in this library. It means six:

| meaning                                                 | classes                                                                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| refill to full                                          | `PowerThrottle`, `PowerGCRA`, `PowerSlidingWindow`, `PowerBackpressure`, `PowerSemaphore`, `PowerRateLimit` |
| refill counting held permits, and reject queued waiters | `PowerPermitGate`, `PowerBulkhead`                                                                          |
| empty the contents                                      | `PowerQueue`, `PowerBatch`, `PowerTTLMap`, `PowerSubscriberSet`, `PowerEventBus`                            |
| zero the measurements                                   | `PowerHistogram`, `PowerEventLoopMonitor`                                                                   |
| return to the initial machine state                     | `PowerCircuit`, `PowerLatch`, `PowerRetryBudget`                                                            |
| halve — a half-life decay, not a clear                  | `smallLfu` (internal)                                                                                       |

**The sharpest pair points in opposite directions.** After `queue.reset()` and
`throttle.reset()` on equally-drained instances, the queue has _nothing_ and the
throttle has _everything_. That is why a single shared `refill()` primitive is
not the obvious answer, and why four of the six categories have no common shape
to abstract over.

Every divergence is deliberate and documented — `smallLfu.reset()` is documented
as "the half-life reset" and has a separate `clear()` for the real clear. What
was missing was enforcement: a reasonable-sounding "harmonise `reset()` across
the library" refactor would silently break callers and nothing in the repository
would notice. `test/resetSemantics.pinned.test.js` is that enforcement.

Two findings the pinning produced, both counter to what the internal review row
assumed:

- **`PowerPermitGate.reset()` counts outstanding holders rather than forgetting
  them.** It sets `available = max(0, min(capacity, capacity - held))`, so with
  capacity 1 and one permit held, `available` is 0 after a reset, not 1. The
  effect that actually distinguishes the gate classes is **rejecting queued
  waiters**, which nothing else does.
- **`PowerBatch.reset()` rejects a pending flush.** Found by the test runner
  rather than by reading: left unhandled, it surfaces as an unhandled rejection
  attributed to a _different_ test. It places `PowerBatch` with the gates rather
  than in plain "empty".

12 tests, 5 mutants, all caught — including the one that matters most for a
harmonisation attempt: making `PowerQueue.reset()` stop emptying.
