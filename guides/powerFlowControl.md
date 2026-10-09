# PowerFlowControl

An adaptive token bucket whose refill rate is set by a closed-loop controller.

## When to use

- A fixed `refillRate` is a guess that is right for one load and wrong for every other
- You already measure something you want to hold steady — queue depth, in-flight count, latency
- You want the limit to retune itself instead of being re-measured and redeployed

## Installation

```js
import { PowerFlowControl } from 'performance-helpers/powerFlowControl';
```

## API

### new PowerFlowControl(options)

Options: `{ capacity?, initialRate?, minRate?, maxRate?, setpoint?, kp?, ki?, kd?, derivativeFilter?, dt?, onRateChange?, now?, observability? }` or just `capacity` (number).

- `capacity` (number, default 1) — bucket size in tokens. The burst one refill interval can admit.
- `initialRate` (number, default 1) — tokens per second, before the first `observe()` moves it.
- `minRate` / `maxRate` (numbers, default `0` / `Infinity`) — bounds on the adaptive rate. `maxRate` is required in practice: an unbounded controller output is not a limit.
- `setpoint`, `kp`, `ki`, `kd`, `derivativeFilter`, `dt` — forwarded to the underlying `PowerServo`.
- `onRateChange(rate, previous)` — called when the rate moves. The hook for pushing the rate into a pool's concurrency setting.
- `now` (function) — injected clock, as the limiters take (PERF-007).

### Methods

- `observe(measured, dt?, disturbance?)` — feed the controller one sample; returns the new rate.
- `tryConsume(n)` — take `n` tokens if available.
- `addTokens(n)` — add tokens directly, bypassing the rate. For tests.
- `reset()` / `clear()` — discard state, resume from `initialRate`.
- `dispose()` / `[Symbol.dispose]()` / `[Symbol.asyncDispose]()` — clears state. This helper owns no timer and no clock, so this is a state reset, not a teardown.

### Properties

- `rate` — the current adaptive rate, tokens per second.
- `tokens`, `capacity` — live bucket state.
- `servo` — the underlying `PowerServo`, for runtime retuning.

## The measurement sign — read this before wiring it up

`observe()` takes the process variable in the servo's own convention: the controller drives it **toward** `setpoint`, so the output rises when `measured` is _below_ the setpoint and falls when it is above.

**That is the opposite of what passing a queue depth directly does.** A deep queue must produce a _higher_ rate, but a deep queue is a _large_ number, and a large measurement drives the output _down_.

Observe the **headroom** instead:

```js
const SETPOINT_DEPTH = 8;

// On a tick, or on every task completion:
const depth = queue.length;
flow.observe(SETPOINT_DEPTH - depth, elapsedMs);
```

A deep queue is a small (or negative) headroom, a small headroom is a large error, and a large error is a high rate. Worked through with `setpoint: 8`, `kp: 1`:

| queue depth | headroom observed | error | rate |
| ----------: | ----------------: | ----: | ---: |
|           2 |                 6 |     2 |    2 |
|           8 |                 0 |     8 |    8 |
|          20 |               -12 |    20 |   20 |

## What it deliberately does not do

It owns **no timer and no clock**. `dt` is an argument to `observe()`, exactly as it is to `PowerServo.step()`, so the same arithmetic serves a `setInterval` tick, a task-completion callback, or a manual call. `dispose()` is therefore a state reset.

It does not decide _when_ to observe. A control loop sampled at the wrong rate is unstable regardless of the gains, and the right sample rate is a property of your plant, not of the bucket.

## The premise, measured

`node bench/claims.js stepsize` settles the question this helper rests on: does a closed-loop controller beat a fixed one? The servo arm peaks at fleet 3 with **zero** overshoot against the fixed arm's peak of 5 with overshoot 4 — 100% less, clearing both the 10% materiality threshold and the noise floor.

## Examples

```js
import { PowerFlowControl } from 'performance-helpers/powerFlowControl';

const flow = new PowerFlowControl({
  capacity: 10,
  initialRate: 50,
  minRate: 1,
  maxRate: 500,
  setpoint: 8,
  kp: 0.4,
  ki: 0.1,
  onRateChange: (rate) => pool.setConcurrency(Math.ceil(rate)),
});

setInterval(() => {
  flow.observe(8 - queue.length, 1000);
}, 1000);

// Admission, wherever work is offered:
if (flow.tryConsume(1)) run();
```

```js
// Deterministic tests: inject the clock and drive it by hand.
let t = 0;
const flow = new PowerFlowControl({
  capacity: 100,
  initialRate: 10,
  now: () => t,
});
flow.tryConsume(100);
t += 500;
expect(flow.tryConsume(5)).toBe(true); // 10/s over 500ms
```

```js
// Takes part in `using` / `await using` like every other long-lived helper.
{
  using f = new PowerFlowControl({ capacity: 10 });
  f.tryConsume(1);
} // state released here
```
