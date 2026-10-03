---
'performance-helpers': minor
---

Add `PowerServo`, a closed-loop transfer function, and `adr/0005`, which records why the library's three other feedback loops are not folded into it.

```js
const servo = new PowerServo({ setpoint: 8, kp: 0.4, ki: 0.1, min: 1, max: 64 });
const consumers = servo.step(queue.size, elapsedMs, arrivalsPerMs);
```

`u = feedforward(disturbance) + C(s) · (setpoint − measured)`, with the controller term PI by default. You supply both terms of the error; the helper supplies the arithmetic. That is the constraint, and it is what separates this from the consolidation ADR 0005 rejects — every existing loop here decides for itself _what to measure_, and that decision is where the two real bugs in those loops were (`RES-003`: a counter that missed two of three grant paths, so AIMD grew its window exactly when the gate was most congested; `ALGO-010`: a controller asleep because the refill drains the queue its own heartbeat was gated on). `PowerServo` shares arithmetic and leaves the measurement decision at the call site. The rule: _if the caller must decide what to measure, do not share that decision._

It exists because three things are easy to get wrong in twenty lines of hand-rolled PI, and each is pinned by a test:

- **The derivative is taken on the measurement, not the error.** Differentiating `setpoint − measured` spikes in proportion to how far the setpoint moved, which is why hand-rolled loops overshoot hardest exactly when an operator retunes. Here a setpoint step produces a flat zero derivative.
- **The integral cannot wind up.** It may only push the output inside `[min, max]`. Back-calculation, the textbook alternative, was implemented first and measured against it: for `kp: 0.5, ki: 2, e: 100, max: 8` it parks the integral at **+179** where clamping holds **−21**, and it took **10** steps after the obstruction cleared before the output came off `max`, against clamping's **1**. An anti-windup mechanism with a stability condition (`Kb · dt < 2`) is a second controller to tune; clamping needs no gain and no condition.
- **A non-finite measurement or feedforward contribution throws.** `NaN` survives every comparison a clamp performs — it is neither `<` nor `>` anything — so it would pass the bounds and then be integrated forever.

`dt` is an argument rather than a clock, so the same arithmetic serves an interval tick, a task-completion callback, or a manual `step()`, and `dispose()` is a **state reset and not a teardown**: the class owns no timer, no listener and no `FinalizationRegistry`, so there is nothing to cancel and the instance stays usable afterwards.

**It cannot diverge, and that is measured rather than asserted.** The output is clamped to `[min, max]` on every step and the integral is clamped so it can only push the output _within_ those bounds; the clamp never consults the gains for its bounds, so no gain configuration escapes. A sweep of `kp` from 0.2 to 6, `ki` and `kd` on and off, and sample intervals from 100 ms to 1 ms, against a first-order lag with 300 ms of transport delay, converged every time with the integral bounded.

**Four unrecoverable states were found by probing the loop, and all four were silent** — the helper kept returning a number while being permanently wrong. `setpoint` is the worst: assigning `NaN` for one step left `output` and `integral` at `NaN` for the rest of the object's life even after restoring the setpoint, because `clamp` cannot catch `NaN` and the integral accumulates it. A `NaN` bound was the quietest, because every comparison against it is false, so the integral clamp stopped firing and the loop wound up with its own guard removed. Assigning a `max` below the current `min` put the output outside both declared bounds and disabled the clamp the same way. A denormal `ki` made the clamp's `lo / ki` overflow and the integral reach `-Infinity`. `setpoint`, `min` and `max` are now validating accessors, so the constructor's validation applies to runtime retunes too, and the clamp's division cannot overflow.

**A slew limit was implemented and removed.** It was justified by a measurement that was counting the wrong thing: 128 output changes at `dt = 100` against 5997 at `dt = 1` read as chatter, but the largest single move was **0.5** on a 100-wide output, total variation was 40, and imposing `maxDelta: 2` made settling _worse_ — variation 98, because delaying the approach keeps the loop moving. The option was accepted on a bad metric, which is the failure `AGENTS.md` calls decoration, so it is gone. The retraction is recorded in the guide and in the class docblock so the next proposal does not re-derive it from the same count.

Sixteen mutants, all killed: derivative on the error, integral clamp removed, clamp window ignoring the feedforward term, clamp window widened to infinity, output bounds not applied, feedforward gain dropped, `saturated` reverted to clip-detection, `reset()` keeping the integral, `dispose()` as a no-op, `step()` ignoring `dt`, and each of the four guards above with its validation removed.

Also in this release:

- **`ALGO-005` closed.** `_updateAdaptiveLimit`'s JSDoc now states that the pool's EWMA is end-to-end task latency while Netflix's controllers track queueing delay — the same quantity only for a uniform workload, so on a pool whose tasks vary in cost `vegas` and `aimd` cannot tell "queueing appeared" from "a heavier task ran". It also records that this pool's `aimd` is delay-shaped despite the name, since it branches on RTT divergence where Netflix's `AIMDLimit` is loss-based. `AutoScaleOptions.policy` no longer publishes a bare union with no statement of what the default does: `ewma` — the default — runs **no** concurrency control, which is why `concurrencyLimit` reports `null` for it. `guides/autoscale.md` mentions `policy` at all for the first time, and no longer recommends hand-rolling a controller against the private `_addWorkerInstance()` without pointing at the supported option.

- **`POOL-012` opened, P1.** `_adaptiveLimit` is written by the controller and read by `getStats()`, and by nothing on the dispatch path — so all three real `autoScale.policy` values move a number the pool does not act on. `POOL-007` found this while scoping and deferred it; it is recorded under Consequences in `adr/0005` so the deferral is visible in committed decision history. **No controller in this library has been measured against a fixed limit**, and `bench/claims.js` has no mode that would compare one.

`PowerServo` currently has **no caller inside the library** beyond its own tests. It is the closed-loop shape the other three loops are not, and `POOL-012`'s `bench/claims.js concurrency` mode is the first thing that would settle whether a controller earns its place here at all.
