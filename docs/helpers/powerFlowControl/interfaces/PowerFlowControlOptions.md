[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerFlowControl](../README.md) / PowerFlowControlOptions

# Interface: PowerFlowControlOptions

## Properties

### capacity?

> `optional` **capacity?**: `number`

Bucket size, in tokens. The burst a single
  refill interval can admit.

***

### derivativeFilter?

> `optional` **derivativeFilter?**: `number`

Forwarded to the servo.

***

### dt?

> `optional` **dt?**: `number`

Default sample interval, forwarded to the servo.

***

### initialRate?

> `optional` **initialRate?**: `number`

Refill rate the bucket starts at, in
  tokens per second, before the first `observe()` moves it.

***

### kd?

> `optional` **kd?**: `number`

Derivative gain. Forwarded to the servo.

***

### ki?

> `optional` **ki?**: `number`

Integral gain. Forwarded to the servo.

***

### kp?

> `optional` **kp?**: `number`

Proportional gain. Forwarded to the servo.

***

### maxRate?

> `optional` **maxRate?**: `number`

Upper bound on the adaptive rate.
  Required in practice: an unbounded controller output is not a limit.

***

### minRate?

> `optional` **minRate?**: `number`

Lower bound on the adaptive rate. `0` means
  the controller may close the bucket entirely.

***

### now?

> `optional` **now?**: () => `number`

Injected clock, as the limiters take
  (PERF-007). Defaults to `Date.now`.

#### Returns

`number`

***

### observability?

> `optional` **observability?**: `boolean` \| [`MetricsCollector`](../../metrics/classes/MetricsCollector.md)

Opt in to metrics. See `guides/metrics.md`.

***

### onRateChange?

> `optional` **onRateChange?**: (`rate`, `previous`) => `void`

Called
  when the adaptive rate moves. The hook a caller uses to push the rate into
  a pool's concurrency setting.

#### Parameters

##### rate

`number`

##### previous

`number`

#### Returns

`void`

***

### setpoint?

> `optional` **setpoint?**: `number`

The value `observe()` should hold. Forwarded
  to the servo.
