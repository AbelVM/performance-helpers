# PowerServo

Closed-loop transfer function. Holds a measured value at a setpoint, with an optional feedforward path for a disturbance you can see before it shows up in the measurement.

```text
u = feedforward(disturbance) + C(s) · (setpoint − measured)
```

where the controller term C(s) is PI by default. You supply both terms of the error; the helper supplies the arithmetic. That is the whole design constraint, and it is the line [ADR 0005](../adr/0005-feedback-signal-picks-the-controller.md) draws — see [Why not one shared controller](#why-not-one-shared-controller).

## Where it is used

`PowerPool`'s `targetMs` autoscale sizes its **worker step** with it. The direction
of a scale action is still the latency EWMA against `targetMs` with a hysteresis
band; the _size_ of the step is chosen by this controller on the relative error, up
to the caller's `stepUp`/`stepDown` ceiling. Measured by
`bench/claims.js stepsize`: peak/final/overshoot of **5/1/4** for the old fixed
step against **3/3/0**. At the default `stepUp: 1` nothing changes, because a
ceiling of one worker is one worker — see the [autoscale
guide](autoscale.md#how-big-a-step).

The two places it is _not_ used are as instructive. `PowerBatch` was measured and
refused: a fixed `maxSize` is already exact, so there is no error to correct. And
`autoScale.policy`'s concurrency limit was measured and refused too — enforcing it
**loses 3.7 %** to the best hand-picked constant cap.

## When you want this

You have a number you are holding steady: a queue depth, a byte ceiling, a pool size, a duty cycle, a latency target. Today you would hold it with a fixed number and a threshold, and the threshold is a guess about where the fixed number should be.

You **do not** want this if you have no setpoint. [`PowerBackpressure`](powerBackpressure.md)'s adaptive refill and [`PowerPool`](powerPool.md)'s `autoScale.policy` observe a signal — an outstanding count, a latency divergence — and correct against a limit rather than a target. Those are not stabilisers and this is not a replacement for them.

## Constructor

| Option             |       Type |     Default | Description                                                                             |
| ------------------ | ---------: | ----------: | --------------------------------------------------------------------------------------- |
| `setpoint`         |   `number` |         `0` | The reference `r`. Writable at any time.                                                |
| `kp`               |   `number` |         `0` | Proportional gain — immediate response to error.                                        |
| `ki`               |   `number` |         `0` | Integral gain. What removes steady-state error. `0` disables it.                        |
| `kd`               |   `number` |         `0` | Derivative gain, taken on the **measurement**.                                          |
| `derivativeFilter` |   `number` |         `0` | Low-pass coefficient on the derivative, `[0, 0.999]`. `0` is raw.                       |
| `min`              |   `number` | `-Infinity` | Lower output bound. Also bounds the integral.                                           |
| `max`              |   `number` |  `Infinity` | Upper output bound. Also bounds the integral.                                           |
| `feedforward`      | `function` |           — | An open-loop term, called each step with `{ measured, setpoint, disturbance, output }`. |
| `feedforwardGain`  |   `number` |         `0` | Static form: `feedforwardGain * disturbance`.                                           |
| `dt`               |   `number` |         `1` | Default elapsed time per `step()`.                                                      |

An unknown option throws. `max < min` throws a `RangeError` — an inverted range has no output inside it, so the loop would have no fixed point to aim at. `min === max` is allowed: that is a fixed output.

## API

- `step(measured, dt?, disturbance = 0)` — Advance one sample and return the control output, clamped to `[min, max]`. Three positional arguments because this is called on a tick: a literal `{ dt, disturbance }` would allocate every step. A non-finite `measured` throws.

- `reset()` — Clear the accumulated integral, remembered measurement, derivative and output. Gains, bounds and setpoint survive: a caller resetting between workloads wants the tuning they already chose.

- `dispose()` / `[Symbol.dispose]()` — **A state reset, not a teardown.** This class owns no timer, no listener and no `FinalizationRegistry`, because `dt` is an argument. There is nothing to cancel. The instance stays usable afterwards, deliberately — see [ADR 0005](https://github.com/AbelVM/performance-helpers/blob/main/adr/0005-feedback-signal-picks-the-controller.md).

- Getters: `output`, `error`, `integral`, `derivative`, `saturated`. `saturated` is `true` when the output is **at** one of the bounds, which after the integral clamp is how you see a pinned loop.

- **`setpoint`, `min` and `max` validate on assignment.** They are meant to be retuned at runtime, so the constructor's validation is not enough on its own. Assigning a `NaN` or infinite `setpoint`, a `NaN` bound, or a `max` below the current `min` throws rather than being absorbed. This is not defensive noise — all four were measured, all four were **silent**, and the quietest was the worst: a `NaN` bound makes every comparison against it false, so the integral clamp simply stops firing and the loop winds up with its own guard removed.

## Example: hold a queue at a depth

```js
import { PowerQueue, PowerServo } from 'performance-helpers';

const queue = new PowerQueue();
const servo = new PowerServo({
  setpoint: 8, // eight items deep
  kp: 0.4,
  ki: 0.1,
  min: 1,
  max: 64,
});

setInterval(() => {
  // dt is real elapsed time, and the gains are tuned for that unit.
  const consumers = servo.step(queue.size, elapsedSinceLastTickMs);
  pool.setConcurrency(consumers);
}, 100);
```

## Example: feed a disturbance forward

The open-loop path reacts to something you already know about, before the measurement moves. With no error at all it can still command an output, which is what makes it useful for a known push on the system:

```js
const servo = new PowerServo({
  setpoint: 50,
  kp: 0.5,
  ki: 0.2,
  min: 1,
  max: 200,
  // Arrivals per ms already predict how much capacity will be needed.
  feedforward: ({ disturbance }) => disturbance * 250,
});

servo.step(queueDepth, 1, arrivalsPerMs);
```

A `feedforward` function that returns a non-finite value throws. It would otherwise become a `NaN` that no comparison can catch — `NaN` is neither `<` nor `>` anything, so it would survive the bounds clamp and then be integrated forever.

## It cannot diverge

A control helper that diverges is the failure everyone fears, so this is worth
stating plainly rather than leaving to the tuning: **there is no gain
configuration that escapes.**

The output is clamped to `[min, max]` on every step, and the integral is clamped
so it can only ever push the output _within_ those bounds. The clamp does not
consult the gains for its bounds — only for which part of the window the
integral may occupy. Measured across a sweep of `kp` from 0.2 to 6, `ki` and `kd`
on and off, and sample intervals from 100 ms to 1 ms, against a 200 ms lag with
300 ms of transport delay: the output stayed inside its bounds and the integral
stayed bounded in all 90 combinations.

**The loop did not converge in all 90, and the difference matters.** It converges
for `kp` up to 1.5 at every sample interval. Past that it limit-cycles — `kp: 3` at
`dt: 100`, and `kp: 6` at `dt: 10` and `dt: 1`, swing the full 0→100 every two
seconds for as long as you leave them running. That is your plant's dead time and
not this arithmetic: 300 ms of pure delay caps the loop gain near `tau / delay`, so
those gains are unstable on that plant and any PI would oscillate. What the clamp
buys you is that such a tuning stays _bounded_ instead of divergent, and
`saturated` reads `true` throughout — so it fails loudly rather than quietly.

Counting the 90 three ways, over a simulated 20 s each: **50 settle on target,
16 sit at a steady offset, 24 limit-cycle.** All 16 offset cases are `ki: 0` —
that is what proportional-only control does, and it is the whole reason the
integral term exists. All 24 cycling cases have a non-zero `ki` and a `kp` above
the stability band. 78 of the 90 report `saturated` at some point, so the flag is
not a rare event and should not be read as one.

If your plant has transport delay, that delay is the first number to measure and
it sets the ceiling on `kp` before any tuning starts.

What bounds the _rate_ of change is the same arithmetic — the output can move by
at most `|kp·Δmeasured| + |ki·error|·dt + |kd·Δmeasured|/dt` in one step, and
each term is yours.

Three failure modes that are **not** divergence, and are therefore your problem
rather than the helper's:

- **A sample interval far finer than the gains were tuned for.** The loop still
  converges, but the integral acts far too fast relative to the plant and the
  output is rewritten far more often — measured as 128 output changes at
  `dt = 100` against 5997 at `dt = 1` for one set of gains. Those moves were
  small (peak 0.5 on a 100-wide output), so this is not thrash; it is a sign the
  gains do not match `dt`, and the fix is `dt` or the gains. Note that the peak
  figure is a _tail_ figure: measured over the whole run including the setpoint
  step, the largest single move is `kp × error` on the first sample — 60 at
  `kp: 0.6` against a 100-unit error — and counting that as chatter is how the
  metric below was misused the first time.
- **`dt: 0`, or a per-step `dt` of 0.** Not a coarse tick: it asserts that no time
  passes between samples, so there is no slope to take. The derivative holds
  rather than dividing by a zero-length span, which is what the integrator does
  too. Before that, `dt: 0` divided by zero and the derivative reached `NaN`
  within two steps and stayed there permanently.
- **A `NaN` anywhere.** `measured`, a `feedforward` return, `setpoint`, `min` and
  `max` all throw rather than propagate one, because `NaN` is neither `<` nor `>`
  anything and so survives a bounds clamp while poisoning the integral
  permanently. An unbounded servo (`min: -Infinity`, `max: Infinity`) has no
  bounds to clamp to, so it is on the caller to keep `measured` finite.

### A slew limit, and why there isn't one

A `maxDelta` option was implemented here and removed. The claim that motivated it
was that a finer sample interval makes the output "chatter" — the 128-against-5997
count above. That count is real and the conclusion was not: it was counting a
0.5-unit move as chatter. Total variation was 40, and imposing a limit made
settling **worse** (98 with `maxDelta: 2`), because delaying the approach keeps
the loop moving. There was no thrash to fix. If you need a plant protected from
steps, limit the step where you apply the output — `pool.resize()` is the right
place, not the controller.

If you re-measure this, state your window **and your gains**, because both change
the answer. Counting the setpoint step as part of the run inverts the conclusion:
over the whole run at `kp: 0.6` the limit _cuts_ total variation (149 → 100) by
capping the first-sample response, while over the settled tail it raises it
(0.36 → 8.0). The 0.5 / 40 / 98 figures above come from an earlier run whose gain
set was not recorded, so they are indicative rather than reproducible; at
`kp: 0.6, ki: 0.02, kd: 0`, output `[0, 100]`, setpoint 100, the settled tail
gives **0.161** and **0.36** against **8.0** with the limit — the same direction, at
a scale an order of magnitude smaller. The durable claim is the direction and the
metric that was wrong, not the exact numbers: the change count was measuring
float-level jitter at `dt = 1`, not motion.

## Tuning

There is no magic here and this library will not pretend otherwise.

- **Start with `ki: 0`.** Pick `kp` so the output moves most of the way to the answer on the first sample. Then add `ki` for whatever error is left over. Proportional action alone always leaves a steady-state offset; that is the integral term's whole job, and it is why a proportional controller settles at `disturbance / kp` and stops. **On a plant with transport delay, measure that delay first** — it caps `kp` near `tau / delay`, and past the cap the loop limit-cycles at full scale rather than converging, which reads as a broken controller and is not one.
- **Match the gains to `dt`, not just to the units.** Gains are only meaningful for the sample rate they were tuned at; see [It cannot diverge](#it-cannot-diverge) for the measured cost of running them finer than that.
- **Set `dt` to real elapsed time** if you are on a clock. `dt: 1` suits a fixed-rate tick and silently integrates at the wrong scale otherwise, which looks like bad tuning rather than a bad default.
- **Set real bounds.** A bound is a constraint — a worker count, a byte ceiling. An arbitrary bound turns the integral clamp into a wall the loop hits and rests against, which is safe but means the loop is not controlling anything.
- **Leave `kd` at `0` unless the plant is fast.** Derivative action amplifies measurement noise in proportion to the sample rate, and a queue or a worker pool is not fast. `derivativeFilter` is there for when you need it, not as a default.
- **Use the feedforward path when you can see the disturbance.** It is the cheapest possible improvement: it costs one function call and removes error the integrator would otherwise have to accumulate.

## What this fixes

Three defects that a hand-rolled PI loop gets wrong, each pinned by a test:

**The derivative is taken on the measurement, not on the error.** Differentiating `setpoint − measured` spikes in proportion to how far the setpoint moved, which is why hand-rolled PIDs overshoot hardest exactly when an operator retunes. Here the setpoint does not appear in the term at all, so a setpoint step produces a flat zero derivative.

**The derivative is low-pass filtered** rather than raw. Raw numerical differentiation amplifies noise by the ratio of signal to sample rate.

**The integral cannot wind up.** The integral may only push the output inside `[min, max]`; anything past that is a number the output cannot use. Back-calculation, the textbook alternative, was implemented first and measured against it — see [ADR 0005](../adr/0005-feedback-signal-picks-the-controller.md).

## Why not one shared controller

This library already has three feedback loops: `PowerBackpressure`'s AIMD refill, `PowerPermitGate`'s, and `PowerPool`'s three `autoScale.policy` controllers. The obvious consolidation is one `PowerController` class with a signal callback, and [ADR 0005](../adr/0005-feedback-signal-picks-the-controller.md) rejects it: each of those loops decides for itself _what to measure_, and that decision is where the project's two real bugs in those loops were (`RES-003`, `ALGO-010`) — one controller reading a counter that missed two of three grant paths, one asleep because the refill drains the queue its heartbeat was gated on.

The rule that separates the two cases:

> If the caller must decide _what to measure_, do not share that decision — put it in a helper only once two callers have independently made the same one.

`PowerServo` passes that test. You compute the setpoint and the measurement, so the signal decision stays where it belongs, and what is shared is arithmetic that is identical everywhere.

## Related

- [PowerBackpressure](powerBackpressure.md) — loss-based AIMD on an outstanding count, for the case with no setpoint.
- [PowerPool autoscaling](powerPool.md#autoscaling) — delay-based controllers on a latency signal.
- [ADR 0005](../adr/0005-feedback-signal-picks-the-controller.md) — the signal taxonomy and the two rejected consolidations.
