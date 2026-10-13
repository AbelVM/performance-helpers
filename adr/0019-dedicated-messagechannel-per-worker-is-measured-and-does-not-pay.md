# 0019. A dedicated MessageChannel per worker is measured, and the row's "costs nothing" is false

**Status:** Rejected
**Affects:** `PowerPool` — no per-worker `MessageChannel` is added
**Evidence:** `node bench/claims.js messageport`, a new mode added for this row, run 2026-10-13. Two runs at the default parameters.

## Context

PISC-010 proposes a dedicated `MessageChannel` per worker for task traffic,
separating it from control traffic, and makes three claims:

1. It "removes the in-band capability-announcement sniffing entirely".
2. "`MessageChannel` is a web standard and ports transfer across realms, so this
   is one of the few Piscina ideas that **costs nothing to adopt here**".
3. It is "a worker-side contract change — every worker must read its port from
   the startup message — so it belongs behind a new `messageCodec` generation or
   a major version".

Claim 2 is the one under test, and it is a **ratio** claim. "Costs nothing" is
only true if what it removes is also nothing, so the mode measures both sides of
that ratio and nothing else.

## Measurement

A new `messageport` mode, in three parts.

**Part 1 — what the sniffing costs per message.** The pool's inbound handler runs
`isCapabilityAnnouncement(data)` and `isNativeEnvelope(data)` on **every** inbound
message, to support an event that arrives once per worker. That is a per-message
tax for a per-worker event, which is the shape worth pricing.

| check                            | on a task reply | on its own kind |
| -------------------------------- | --------------- | --------------- |
| `isCapabilityAnnouncement(data)` | 4.9 ns          | 5.9 ns          |
| `isNativeEnvelope(data)`         | 6.7 ns          | 5.5 ns          |
| **per inbound message**          | **11.6 ns**     |                 |

The third check on that path, `isReadySignal`, is deliberately **excluded**: it is
gated behind `_readyField != null && !workerObj.ready`, so once a worker has
reported ready it never runs again. It is a start-up cost, not a per-message one,
and folding it in would overstate the tax.

The denominator is a **real** `worker_threads` worker, because the fraction is the
whole point: 12 ns is nothing against an 18 µs path and a great deal against a
200 ns one. The worker uses the library's own codec rather than a hand-rolled
echo, so it cannot win by having its work skipped.

|                                    |              |
| ---------------------------------- | ------------ |
| framed round trip, real worker     | **17.97 µs** |
| sniffing as a fraction of the path | **0.065 %**  |

**Part 2 — what a dedicated port costs per worker.**

|                                  |              |
| -------------------------------- | ------------ |
| `new MessageChannel()`           | 6.41 µs      |
| startup message, plain body      | 7.23 µs      |
| startup message, carrying a port | 16.80 µs     |
| **port transfer premium**        | **9.56 µs**  |
| **per worker, total**            | **15.97 µs** |

Plus a second `message` listener per worker, which is not timed because it is a
memory and dispatch cost rather than a latency one.

**Part 3 — the ratio the row calls "nothing".**

|                      |                                 |
| -------------------- | ------------------------------- |
| removed per message  | 11.6 ns                         |
| added per worker     | 15.97 µs                        |
| **break-even**       | **1 376 messages per worker**   |
| saving at break-even | **0.065 % of the message path** |

## Decision

`PowerPool` gains no per-worker `MessageChannel`, and the worker startup contract
does not change.

**The row's premise is false on both halves of its own ratio.** A dedicated port
does not cost nothing — it costs **15.97 µs per worker**, of which 9.56 µs is the
structured clone of the port in the startup message alone. And what it removes is
**0.065 % of the message path**, because the path is dominated by the structured
clone and the worker turn, not by two property checks.

The break-even is 1 376 messages per worker, so for a long-lived worker the port
does eventually pay for itself in absolute nanoseconds. **That is the trap in the
row's framing.** Even at break-even the saving is 0.065 % of the path, and the
price is a worker-side contract change behind a major version — every worker must
read its port from the startup message, which breaks every existing worker file
that does not. A major version bought for 0.065 % is the wrong trade, and the
row's own claim 3 says as much while claim 2 denies it.

The measured fraction is also an **upper bound**. 17.97 µs is the bare worker
round trip; the pool's real inbound path adds correlation matching, latency
sampling and the task queue on top of it, so the true fraction is smaller still.

### What the feature would actually buy

Not performance. The honest case for a dedicated port is **architectural**: task
traffic and control traffic stop sharing a channel, so a task message can never
be mistaken for a capability announcement, and the pool's inbound handler loses a
branch it only needs because the two are mixed. That is a real clarity gain and
it is not what the row claims.

Against it: 15.97 µs per worker, a second listener per worker, a startup-contract
change, and a major version.

## Consequences

- **The sniffing is not worth removing, and the row's own numbers say so.** The
  row prices the adoption as nothing; it is 15.97 µs per worker against 11.6 ns
  per message. Any future proposal to remove a per-message check should be quoted
  against the message path it sits on, not against zero.
- **`isReadySignal` is not a per-message cost and should not be counted as one.**
  It is gated behind `_readyField != null && !workerObj.ready`, so it stops
  running once a worker reports ready. A proposal that folded it in would be
  pricing a start-up branch as a steady-state one.
- **The mode stays.** `messageport` is the only measurement here of what a port
  costs, and the next proposal to add one per worker — for task traffic, for
  control traffic, or for anything else — should find the 15.97 µs rather than
  re-derive it.

## What survives

The mode, and one number worth keeping: **a `MessageChannel` plus a port in the
startup message costs about 16 µs per worker on this machine.** That is the price
of any per-worker port in this library, and it is now measured rather than
asserted.

## Not measured

- **A browser runtime.** `worker_threads` is Node-only. A browser `MessagePort`
  has different clone and scheduling costs, and the 15.97 µs should not be quoted
  for one. The row's "ports transfer across realms" is true of both and is not
  the disputed claim.
- **The pool's full inbound path.** The 17.97 µs denominator is the bare worker
  round trip, not the pool's, so the fraction quoted here is an upper bound. The
  pool's own bookkeeping would make it smaller, which strengthens the conclusion
  rather than weakening it.
- **Many workers at once.** One worker is measured, because the per-worker cost
  is what the ratio is about. Contention between N workers' ports is a different
  question and is not what the row claims.
