[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerFlowController](../README.md) / PowerFlowControllerOptions

# Interface: PowerFlowControllerOptions

## Properties

### burst?

> `optional` **burst?**: `number`

GCRA burst tolerance, in operations. How many
  may run back-to-back before the sustained rate applies.

***

### derivativeFilter?

> `optional` **derivativeFilter?**: `number`

Forwarded to the servo.

***

### dt?

> `optional` **dt?**: `number`

Default sample interval, forwarded to the servo.

***

### kd?

> `optional` **kd?**: `number`

Derivative gain, on the measurement. Off by
  default: a p99 over a short window is noisy, and differentiating noise is
  how a loop starts to oscillate.

***

### ki?

> `optional` **ki?**: `number`

Integral gain. **Non-zero by default, and it
  has to be.** With `ki: 0` the output is `kp × error` alone, so a window that
  meets its target exactly produces an error of zero and therefore a rate of
  zero — which the `minRate` clamp turns into the floor. Measured: P-only
  settled at 11% of the rate the plant could sustain at the target latency.
  The integrator is what holds the rate up when there is no error left to
  correct.

***

### kp?

> `optional` **kp?**: `number`

Proportional gain, in (operations per second)
  per millisecond of latency error.

***

### maxRate?

> `optional` **maxRate?**: `number`

Upper bound on the adaptive rate.
  Required in practice: an unbounded controller output is not a limit.

***

### minRate

> **minRate**: `number`

Lower bound on the adaptive rate. **Must be
  greater than 0.** The actuator is a GCRA, whose rate must be finite and
  positive, so "admit nothing" is not a rate this controller can represent — a
  caller who wants to stop admitting should stop calling `admit()`.

***

### now?

> `optional` **now?**: () => `number`

Injected clock, as the limiters take
  (PERF-007). Defaults to `Date.now`.

#### Returns

`number`

***

### observability?

> `optional` **observability?**: `boolean` \| [`MetricsCollector`](../../helpers/metrics/classes/MetricsCollector.md)

Opt in to metrics. See `guides/metrics.md`.

***

### onRateChange?

> `optional` **onRateChange?**: (`rate`, `previous`) => `void`

Called
  when the rate moves. The hook for pushing the rate into a pool's concurrency
  setting.

#### Parameters

##### rate

`number`

##### previous

`number`

#### Returns

`void`

***

### quantile?

> `optional` **quantile?**: `number`

Which quantile of the window drives the
  loop. `0.99` is the p99; `0.5` would make it a median controller.

***

### queueCapacity?

> `optional` **queueCapacity?**: `number`

Bound on the waiting queue. `submit()`
  returns `false` and increments `dropped` when it is full.

***

### rate

> **rate**: `number`

Initial sustained rate, in operations per second.
  Required: a controller with no starting rate has nothing to clamp.

***

### relativeAccuracy?

> `optional` **relativeAccuracy?**: `number`

Forwarded to the histogram.

***

### targetP99?

> `optional` **targetP99?**: `number`

The latency setpoint, in milliseconds. The
  servo drives the p99 toward this.
