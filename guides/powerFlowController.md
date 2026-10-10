# PowerFlowController

Admission, queueing and latency feedback in one closed loop.

## When to use

- You have a rate limit that is a guess, and a latency SLO that is not
- Work arrives faster than it can be served, and you need to decide what to shed
- You already measure tail latency somewhere and want it to drive the limit

## When not to

- **You want a fixed rate.** Use `PowerGCRA` or `PowerThrottle`. A controller that
  retunes itself is more moving parts than a limit you have already measured.
- **You want to bound concurrency, not rate.** Use `PowerSemaphore` or
  `PowerBulkhead`.
- **You want to shape a producer against a slow consumer.** Use
  `PowerBackpressure`, which is AIMD on a permit gate and needs no latency
  measurement at all.

## Installation

```js
import { PowerFlowController } from 'performance-helpers/powerFlowController';
```

## API

### new PowerFlowController(options)

| option             |                type |    default | description                                                                                                    |
| ------------------ | ------------------: | ---------: | -------------------------------------------------------------------------------------------------------------- |
| `rate`             |            `number` | _required_ | Starting sustained rate, operations per second. Must be finite and `> 0`.                                      |
| `burst`            |            `number` |        `0` | GCRA burst tolerance, in operations. How many may run back-to-back before the sustained rate applies.          |
| `minRate`          |            `number` | _required_ | Floor on the adaptive rate. **Must be greater than 0** — see below.                                            |
| `maxRate`          |            `number` | `Infinity` | Ceiling on the adaptive rate. Required in practice: an unbounded controller output is not a limit.             |
| `targetP99`        |            `number` |       `50` | The latency setpoint, in milliseconds. The servo drives the p99 toward this.                                   |
| `quantile`         |            `number` |     `0.99` | Which quantile of the window drives the loop. `0.99` is the p99; `0.5` would make it a median controller.      |
| `queueCapacity`    |            `number` |      `100` | Bound on the waiting queue. `submit()` returns `false` and increments `dropped` when it is full.               |
| `kp`               |            `number` |     `0.05` | Proportional gain, in (operations per second) per millisecond of latency error.                                |
| `ki`               |            `number` |    `0.001` | Integral gain. **Non-zero by default, and it has to be** — see the measurement table below.                    |
| `kd`               |            `number` |        `0` | Derivative gain, on the measurement. Off by default: a p99 over a short window is noisy.                       |
| `derivativeFilter` |            `number` |        `0` | First-order low-pass coefficient on the derivative, in `[0, 1)`. Ignored when `kd` is `0`.                     |
| `dt`               |            `number` |        `1` | Default sample interval, in the same unit as the gains.                                                        |
| `relativeAccuracy` |            `number` |     `0.01` | Forwarded to the histogram. A smaller value means more buckets.                                                |
| `onRateChange`     |          `function` |     `null` | Called as `onRateChange(rate, previous)` when the rate moves. The hook for pushing the rate into a pool.       |
| `now`              |          `function` | `Date.now` | Injected clock, as the limiters take (PERF-007).                                                               |
| `observability`    | `boolean`/collector |    `false` | `true` registers in the shared collector, or pass your own `MetricsCollector`. See [`metrics.md`](metrics.md). |

### Methods

- `submit(item)` — offer an item. Returns `false` and increments `dropped` when
  the queue is full. Does **not** consult the rate limiter.
- `admit()` — take the next item if the GCRA admits one, else `null`.
- `record(ms)` — record one operation's latency.
- `observe(dt?)` — advance the loop; returns the new rate.
- `reset()` / `clear()` — discard the queue, the window and the learned rate.
- `dispose()` / `[Symbol.dispose]()` / `[Symbol.asyncDispose]()` — state reset.

### Properties

- `rate`, `minRate`, `maxRate`, `targetP99` — the loop's configuration.
- `depth`, `queueCapacity`, `dropped` — the queue.
- `p99` — the **current, partial window**. `undefined` when empty.
- `limiter`, `servo`, `latency`, `queue`, `now` — the composed primitives.

### stats()

`{ rate, minRate, maxRate, targetP99, quantile, depth, queueCapacity, submitted, admitted, recorded, dropped, observations, p99, saturated }`. `getStats()` is an alias.

**`dropped` is the number to alert on.** A flow controller that is dropping is one
whose rate is too low for the offered load, and nothing else here says so — the
queue is bounded by design, so a healthy-looking `depth` is exactly what overload
looks like.

**`observations` is the second number to alert on.** It counts loop samples, so a
loop that has stopped being fed is a loop whose rate has gone stale — and a stale
rate is a limit that is no longer limiting anything, which fails silently in the
direction that looks like working code.

## The three things this composes

| Concern   | Primitive        | Where it shows up                     |
| --------- | ---------------- | ------------------------------------- |
| Admission | `PowerGCRA`      | `admit()`, and the rate the loop sets |
| Queueing  | `PowerQueue`     | `submit()`, `depth`, `dropped`        |
| Latency   | `PowerHistogram` | `record()`, `p99`                     |
| The loop  | `PowerServo`     | `observe()`, `saturated`              |

## The measurement sign — read this before wiring it up

`observe()` feeds the servo the **p99 latency in milliseconds**, and the setpoint
is `targetP99`. The servo drives its measurement toward the setpoint, so:

```text
error = targetP99 − p99
```

A p99 **above** the target is a negative error and drives the rate **down**. A p99
below it is a positive error and drives the rate **up**.

**That is the natural direction, and it is the reason latency is the process
variable here.** Compare `PowerFlowControl`, whose guide devotes a whole section
to the sign trap: the natural quantity there is queue depth, and a deep queue must
produce a _higher_ rate while reading as a _large_ number, so the caller has to
observe the headroom instead. Latency needs no such inversion.

## Why the window resets, and why that is not optional

`observe()` reads the p99 of the samples recorded **since the previous
`observe()`** and then clears them.

A cumulative histogram was measured first and is wrong for this plant. The loop
then sees a _lifetime_ p99, so a rate that has already been cut keeps being judged
against the traffic that justified the cut — and it never comes back. On the plant
below, a cumulative window held the rate at its floor for the whole run while a
per-window one converged on the target.

The consequence you have to know about: **`p99` is the current, partial window**,
not a lifetime figure. `latency` exposes the underlying histogram for anyone who
wants `snapshot()` or `toJSON()`.

## The premise, measured

The plant is deterministic and stated in closed form, so the equilibrium rate is
arithmetic rather than a measurement to argue about:

```text
latency(rate) = 5 ms + (rate / cap) × 90 ms
```

At a 30 ms target, `cap: 400` sustains exactly **111.1/s** and `cap: 150` sustains
exactly **41.7/s**. The loop has to find those from latency feedback alone.

| Configuration         | Equilibrium reached | Overshoot on a load step |
| --------------------- | ------------------: | -----------------------: |
| `kp: 0.05, ki: 0.001` |        111.1 → 41.7 |               **0.0 ms** |
| `kp: 0.1, ki: 0.0005` |        111.1 → 41.7 |                   0.0 ms |
| `kp: 0.1, ki: 0.002`  |        111.1 → 70.9 |                  27.6 ms |
| `kp: 0.2, ki: 0.004`  |  limit-cycles 5↔761 |                  62.2 ms |
| `kp: 0.5, ki: 0.05`   |     latches at 13/s |               167 ms p99 |
| `kp: 0.2, ki: 0.01`   |  limit-cycles 5↔761 |                        — |
| `ki: 0` (P only)      |      settles at 11% |                        — |

Three things that table says, in order of how much they will bite:

1. **The gain band is narrow, and the defaults sit inside it.** `kp: 0.05,
ki: 0.001` reaches both equilibria with zero overshoot. Double the gains and
   the loop overshoots by 62 ms; double them again and it limit-cycles across the
   whole range. This is not a defect in the arithmetic — 90 ms of plant gain
   against a 30 ms target caps the usable loop gain, and any PI would do it. The
   clamp is what keeps a bad tuning _bounded_ rather than divergent, and
   `saturated` is `true` throughout.
2. **`ki` must be non-zero, and the default is non-zero for that reason.** With
   `ki: 0` the output is `kp × error` alone, so a window that meets its target
   exactly produces an error of zero and therefore a rate of zero — which the
   `minRate` clamp turns into the floor. P-only settled at 11% of the rate the
   plant could sustain at the target latency.
3. **The loop is robust to the sample interval.** The equilibrium came out at
   108–111/s across `dt` from 100 ms to 2000 ms, because the integral dominates
   at steady state. You do not have to tune the gains against your tick rate.

## The cold start, and the one-step integral lag

`PowerServo` computes its feedback term from the integral **as it was before this
step's update**, so the integral's contribution is always one step behind. The
first observation after construction can therefore only ever produce
`kp × error` — with `kp: 0.05` and a 28 ms error that is 1.4, which the `minRate`
clamp turns into the floor.

Measured climb from a cold start at `maxRate: 210`, one observation per second:

```text
5.0 → 30.4 → 59.5 → 88.5 → 117.5 → 146.4 → 175.4 → 204.4 → 210.0
```

Eight observations to reach the ceiling. Under sustained overload the rate goes
straight to `minRate` on the first observation and holds there, which is the
controller doing its job.

If a slow start matters, call `observe()` once with a representative sample before
you rely on the rate, or start `rate` near where you expect to settle.

## Why queue depth is not a control input

Depth is ambiguous in a way latency is not. A deep queue with healthy latency is a
backlog to drain; a deep queue with unhealthy latency is overload to shed. The
same number means both, and a controller cannot tell them apart from the depth
alone.

Delay is the signal the congestion-control literature settled on for exactly this
reason. Depth is still here — it is the bound, it is `stats().depth`, and it is the
number to alert on — it is just not the process variable.

## What it deliberately does not do

It owns **no timer and no clock**. `dt` is an argument to `observe()`, exactly as
it is to `PowerServo.step()`, so the same arithmetic serves a `setInterval` tick, a
task-completion callback, or a manual call. `dispose()` is therefore a state reset
and not a teardown.

It does not decide _when_ to observe. A control loop sampled at the wrong rate is
unstable regardless of the gains, and the right sample rate is a property of your
plant, not of the controller.

It cannot represent "admit nothing". The actuator is a GCRA, whose rate must be
positive, so `minRate: 0` is refused at construction. A caller who wants to stop
admitting should stop calling `admit()` — which is both simpler and observable.

## Examples

```js
import { PowerFlowController } from 'performance-helpers/powerFlowController';

const flow = new PowerFlowController({
  rate: 200,
  minRate: 5,
  maxRate: 800,
  targetP99: 30,
  kp: 0.05,
  ki: 0.001,
  queueCapacity: 256,
  onRateChange: (rate) => pool.resize(Math.ceil(rate)),
});

// Producer side — bounded, and counted when it drops.
if (!flow.submit(job)) metrics.dropped();

// Consumer side — the rate gate.
const job = flow.admit();
if (job) {
  const t0 = flow.now();
  await run(job);
  flow.record(flow.now() - t0);
}

// The loop, on a tick.
setInterval(() => flow.observe(1000), 1000);
```

```js
// Deterministic tests: inject the clock and drive it by hand.
let t = 0;
const flow = new PowerFlowController({
  rate: 100,
  minRate: 1,
  targetP99: 30,
  now: () => t,
});
flow.submit('a');
t += 1000;
flow.admit();
flow.record(12);
expect(flow.observe(1000)).toBeGreaterThan(0);
```

```js
// Takes part in `using` / `await using` like every other long-lived helper.
{
  using flow = new PowerFlowController({ rate: 100, minRate: 1 });
  flow.submit('a');
} // state released here
```
