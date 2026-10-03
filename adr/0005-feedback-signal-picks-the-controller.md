# 0005. A loop's signal picks the controller, not the other way round

**Status:** Accepted
**Affects:** `PowerPool`, `PowerBackpressure`, `PowerPermitGate`

## Context

Three feedback loops ship in this library, and their arithmetic is nearly
identical — a bound, a `beta`, an additive step, and in one case a smoothing
factor:

| Loop                           | Where                                 | Window step                                                         |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------------------- |
| `aimd` / `vegas` / `gradient2` | `powerPool.js` `_updateAdaptiveLimit` | `congested ? limit * beta : limit + 1`, clamped, smoothed 0.8/0.2   |
| `_aimdStep`                    | `powerBackpressure.js`                | `inFlight >= capacity ? refill * beta : refill + additive`, clamped |

A reasonable-looking proposal follows from that table: extract the shared shape
into one `PowerController` and let each call site supply only its signal. Three
knobs, one class, one place to tune.

It was declined, and the reason is in this project's own defect history. Both
real bugs in these loops were in the **signal and the call site**, and neither
was in the arithmetic:

- **`RES-003`.** `PowerPermitGate._inFlight` missed two of its three grant paths,
  so it read `0` while permits were outstanding. AIMD therefore took its
  _additive_ branch exactly when the gate was most congested — a window that only
  grows, on a signal that was always zero.
- **`ALGO-010`.** The same controller, once the counter was honest, still made
  **2** decisions in 400 ms and then froze for the object's lifetime. The refill
  drains the queue it exists to relieve, so anything gated on "is anyone
  waiting?" is gated on something usually false (ADR 0004). After the heartbeat
  armed its own timer: 97 steps.

Both fixes touched how often the loop was asked and what it was asked. Neither
touched `limit * beta`. A shared primitive would have exported the one part that
never broke and pushed the part that keeps breaking out to every caller.

## The taxonomy

What separates these loops is not the update rule. It is **what the loop can
observe**. Four signal shapes, and a given helper has exactly one or two of them:

| Signal               | Question it answers                         | Needs                                 | Ships in                                   |
| -------------------- | ------------------------------------------- | ------------------------------------- | ------------------------------------------ |
| **Setpoint / error** | how far is the measurement from a target?   | a target _and_ a measurement          | nothing — see below                        |
| **Delay**            | is extra concurrency buying queueing?       | a load-free latency baseline          | `vegas`, `gradient2` (pool)                |
| **Loss**             | did the probe come back?                    | a probe, and a clock-free "still out" | `_aimdStep` (gate); `aimd` (pool, by name) |
| **Rate**             | is the queue draining faster than it fills? | two observations and an interval      | nothing                                    |

`PowerPool` has an end-to-end task latency EWMA, a long-window EWMA, a window
minimum, and a queue depth — enough for **delay**. `PowerBackpressure` has
in-flight permits against a pool size and no clock at all — enough for **loss**,
and nothing else. It is a producer/consumer gate, not an RPC: there is no
round-trip for a delay controller to measure. `ALGO-010` settled that, and the
comment in `_aimdStep` says so at the call site.

**Setpoint is absent on purpose.** Nothing here targets a number — not a
latency SLO, not a p99. The one option that looks like a setpoint,
`autoScale.targetMs`, is a threshold in a scale-up/scale-down rule, not an error
term fed back into an output; the worker count is the output and `targetMs` is
compared against it once. A controller here would need `targetMs` to become a
continuous error rather than a comparison, which changes what autoscaling does
to a pool rather than adding a helper.

**Rate is the honest shape for a delay-shaped gate controller**, and it is not
built. If the gate ever wants a Vegas-shaped loop, queue-drain rate — is `pending`
falling faster than it rises — is the quantity that transfers. It was not built
because the loss signal was legitimate once fixed, so there was nothing left to
solve.

### Two naming facts a reader will get wrong

**Netflix's controllers track _queueing delay_, and this pool's EWMA is end-to-end
task latency.** They are the same quantity only for a uniform workload. For a
pool whose tasks vary in cost, `vegas`' `minRtt / currentRtt` conflates
"queueing appeared" with "a heavier task ran", and the pool will cut its
concurrency for work that was simply expensive. That gap is `ALGO-005`, and it is
now stated in `_updateAdaptiveLimit`'s JSDoc rather than left in the review.

**The pool's `aimd` is a delay controller, despite the name.** Netflix's
`AIMDLimit` is loss-based; this pool's `aimd` branches on
`shortRtt > longRtt * 1.25`, which is the same RTT-divergence shape as
`gradient2`. The gate's AIMD is the loss-based one. Two policies in one class, one
name between them, and the name points at the other class — recorded here so the
next reader does not "fix" the pool's `aimd` into a loss test and find it stops
working.

## Decision

**The controller lives next to the thing that owns the signal.** No shared
primitive, no `PowerController`, and no abstraction that takes a
`signal(observation)` callback — the last is the same proposal with the
arithmetic deleted, which leaves a bag of options and the call site unchanged.

**One carve-out, and it is not a weakening: a controller the caller _drives_.**
Where a helper's need is a _setpoint_ — hold this number here — the caller
already knows both terms of the error, and `PowerServo` is the arithmetic with
the decision left where it was. That is the "The setpoint case" section below,
and the rule that separates it from everything above is one sentence: **if the
caller must decide what to measure, do not share that decision.**

The durable artefact is this table, and it earns its keep at the call site: when
someone asks for a controller in a new helper, the first question is which of the
four signals that helper can actually observe, and the answer is usually "none
of the delay ones" or "only loss".

The arithmetic stays duplicated on purpose. It is eight lines per loop, and the
alternative buys a shared shape at the cost of a shared list of knobs that each
caller ignores — the same trade ADR 0004 made for
`PowerSemaphore`/`PowerBulkhead`/`PowerPermitGate` over one gate.

## Consequences

- `vegas` and `gradient2` are only offered on `PowerPool`, because that is the
  only class with a load-free latency baseline.
- `PowerBackpressure`'s AIMD stays loss-based and clock-free, and its test
  comment names the reason.
- A new loop in a new helper needs the signal named before it is written. If the
  helper has no signal, the loop will be inert — which is the failure mode
  `RES-003` and `ALGO-010` both were.
- The default `autoScale.policy` is `'ewma'`, which runs **no** concurrency
  control: `_updateAdaptiveLimit` returns the seed value untouched, and
  autoscaling is worker-count scaling only. `guides/powerPool.md` says this and
  `AutoScaleOptions.policy` now says it in the published type.
- **Open, and deliberately not resolved here:** the pool's `_adaptiveLimit` is
  written by the controller and read by `getStats()`. It is not read on the
  dispatch path, so `concurrencyLimit` reports a belief the pool does not
  currently act on. Confirmed by exhaustive read of every occurrence in
  `powerPool.js` — seeded, self-read by the update, written by the update,
  reported by stats — and consistent with `test/powerPool.adaptiveConcurrency.test.js`,
  which asserts only that the number moves. `POOL-007` deferred it as a separate
  question because changing it would alter a field consumers read. It is recorded
  here so the deferral is visible in the decision history rather than only in a
  row's note: **no controller in this library has been measured against a fixed
  limit**, so "the controller beats the heuristic" is currently an untested
  premise, and `bench/claims.js` has no mode that would test it.

## Alternatives considered

**One `PowerController` with `{ beta, additiveIncrease, min, max }` and a signal
callback.**
Rejected for the reason above: every defect these loops have had was outside the
part being shared. A knob bag with six settings, of which each call site uses
three, is worse than eight duplicated lines, because the duplication is visible
and the knob bag hides which three matter.

**One `PowerController`, with the signal logic pushed into per-class adapters.**
Rejected as the same proposal with more code. The adapter is where the defect
was; an interface that every caller implements separately is not a shared
controller, it is a naming convention.

**A delay-shaped controller for `PowerBackpressure` via a queue-drain rate.**
Not rejected — parked. It is the right signal for that class, and it was not
built because the loss signal was legitimate once `RES-003` was fixed. If the
gate ever needs to bound queueing latency rather than permit exhaustion, this is
where to look, and `ALGO-010` already names it.

**Make `PowerBackpressure` expose a request-style RTT so `vegas` transfers.**
Rejected twice already, in ADR 0004 and `ALGO-010`. A permit gate has no
request/response cycle, so there is nothing to measure; the honest analogue of
"did my probe come back" is the loss signal the class uses.

**A setpoint helper (`PowerServo` and similar).**
Accepted, and shipped — see the section below. The rejection recorded earlier in
this ADR was of a helper that shares _observation_; this one shares _arithmetic_
and is handed the error already computed, which is the distinction the rest of
this document turns on.

## The setpoint case, which reverses the rejection above

The three loops this ADR is about all **observe**. Each one decides for itself
what to measure — a latency divergence, an outstanding count, a drain rate — and
that choice is the part that breaks, as `RES-003` and `ALGO-010` both show. So
this ADR rejects sharing the observation.

A closed-loop transfer function is the other shape:

```
u = feedforward(disturbance) + C(s) · (setpoint − measured)
```

The caller computes `setpoint − measured` and passes both in. **The signal
decision does not move** — it stays at the call site, in the class that owns the
measurement — and what is shared is arithmetic that is genuinely identical
everywhere: proportional and integral terms, an integrator that must not wind up,
a derivative that must be taken on the measurement rather than the error, and
output bounds. No knob is ignored by any caller, which is the specific thing that
made the observation-side primitive worse than duplicated lines.

The distinction is worth stating as a test, because it is the whole argument:

> If the caller must decide _what to measure_, do not share the decision — put it
> in a helper only once two callers have independently made the same one.

`PowerServo` passes that test. `PowerController` did not, and neither would a
`signal(observation)` interface, which is the same abstraction with the decision
still inside.

### What the helper does not do

It does not own a timer. It is called when the caller has a measurement, so it
is a pure function of its inputs plus an integrator — which means its `dispose()`
is a **state reset** (the integrator and the previous measurement, nothing else),
per `AGENTS.md`'s rule that a lazy helper's dispose is a reset and not a
teardown. It does not own a clock: `dt` is an argument, so a caller running on a
timer, on a task completion, or on a completion callback gets the same
arithmetic. And it does not decide a control law for you — PI is the default
because it is the one that works without tuning, and the integral term is what
removes steady-state error that proportional action alone leaves behind.

## Where this is visible

- `src/helpers/powerPool.js`, `_updateAdaptiveLimit`'s JSDoc: the
  queueing-delay/end-to-end-latency gap, and the `'ewma'` default doing nothing.
- `src/helpers/jsdoc-types.js`, `AutoScaleOptions.policy`: the same two facts in
  the published type.
- `guides/autoscale.md`: which policies exist and that the default is not one of
  them.
- `src/helpers/powerBackpressure.js`, `_aimdStep`'s JSDoc and
  `guides/powerBackpressure.md`: why this class is loss-based and not delay-based.
- `src/helpers/powerServo.js` and `guides/powerServo.md`: the setpoint case above.
- `review.md`'s `ALGO-005`, `ALGO-010`, `RES-003`, `RES-024`, `POOL-007`,
  `POOL-012`.
