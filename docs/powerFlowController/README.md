[**performance-helpers**](../README.md)

***

[performance-helpers](../README.md) / powerFlowController

# powerFlowController

PowerFlowController — admission, queueing and latency feedback in one loop.

The library had three separate answers to "slow down", and none of them was
the whole question:

- `PowerGCRA` and `PowerThrottle` answer **admission** — at what rate may work
  start — at a rate fixed at construction.
- `PowerQueue` and `PowerBackpressure` answer **queueing** — how much may wait,
  and what happens when it cannot.
- `PowerHistogram` answers **measurement** — what the tail latency actually was.

A realtime service needs all three wired together: admit at a rate, buffer what
does not fit, measure the latency that results, and move the rate. This helper
is that loop, and it is a **composition** — `PowerGCRA`, `PowerQueue`,
`PowerHistogram` and `PowerServo`, with no new arithmetic of its own beyond
deciding when the loop has something to learn.

### The shape

```text
  submit(item) ──► bounded queue ──► admit() ──► GCRA ──► caller runs it
                                       ▲                    │
                                       │                    ▼
                                  setRate(rate) ◄── PowerServo ◄── p99
                                                            ▲
                                                     PowerHistogram
                                                            ▲
                                                      record(latencyMs)
```

The producer side is `submit()`, which bounds the queue and counts what it
drops. The consumer side is `admit()`, which is the GCRA gate. The measurement
side is `record()`, and the loop is `observe()`.

### Why the latency window resets, and why that is not optional

`observe()` reads the p99 of the samples recorded **since the previous
`observe()`** and then clears them. A cumulative histogram was measured first
and is wrong for this plant: the loop then sees a *lifetime* p99, so a rate
that has already been cut keeps being judged against the traffic that
justified the cut, and it never comes back. Measured on the plant in
`guides/powerFlowController.md`, a cumulative window held the rate at its
floor for the whole run while a per-window one converged on the target.

The consequence a caller has to know about: **`p99` is the current, partial
window**, not a lifetime figure. `latency` exposes the underlying histogram for
anyone who wants `snapshot()` or `toJSON()`.

### What it deliberately does not do

It owns **no timer and no clock**. `dt` is an argument to `observe()`, exactly
as it is to `PowerServo.step()`, so the same arithmetic serves a `setInterval`
tick, a task-completion callback, or a manual call. `dispose()` is therefore a
state reset and not a teardown.

It does not feed **queue depth** to the servo, and that is a decision rather
than an omission. Depth is ambiguous in a way latency is not: a deep queue with
healthy latency is a backlog to drain, and a deep queue with unhealthy latency
is overload to shed, and the same number means both. Delay is the signal the
congestion-control literature settled on for exactly this reason. Depth is
still here — it is the bound, it is `stats().depth`, and it is the number to
alert on — it is just not the process variable.

## Classes

- [PowerFlowController](classes/PowerFlowController.md)

## Interfaces

- [PowerFlowControllerOptions](interfaces/PowerFlowControllerOptions.md)

## References

### default

Renames and re-exports [PowerFlowController](classes/PowerFlowController.md)
