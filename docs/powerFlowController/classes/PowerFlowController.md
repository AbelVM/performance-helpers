[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerFlowController](../README.md) / PowerFlowController

# Class: PowerFlowController

A closed loop from measured tail latency to an admission rate.

## Example

```ts
const flow = new PowerFlowController({
  rate: 200,
  minRate: 5,
  maxRate: 800,
  targetP99: 30,
  kp: 0.05,
  ki: 0.001,
});

// Producer side — bounded, and counted when it drops.
if (!flow.submit(job)) dropped++;

// Consumer side — the rate gate.
const job = flow.admit();
if (job) {
  const t0 = flow.now();
  await run(job);
  flow.record(flow.now() - t0);
}

// The loop, on a tick.
flow.observe(elapsedMs);
```

## Constructors

### Constructor

> **new PowerFlowController**(`options?`): `PowerFlowController`

#### Parameters

##### options?

[`PowerFlowControllerOptions`](../interfaces/PowerFlowControllerOptions.md)

`rate` and `minRate` are
  required in practice: the constructor throws without either. The parameter
  stays optional because those throws are the documented way a missing value
  is reported, and `new PowerFlowController()` must stay callable to reach
  them.

#### Returns

`PowerFlowController`

## Properties

### \_admitted

> **\_admitted**: `number`

***

### \_disposed

> **\_disposed**: `boolean`

***

### \_dropped

> **\_dropped**: `number`

***

### \_initialRate

> **\_initialRate**: `number`

The configured starting rate, kept separately from `_rate` because
`reset()` has to restore *this* and not `minRate` — a reset means "forget
what you learned", and the configured rate is the caller's own statement
about what the workload should get.

***

### \_latency

> **\_latency**: [`PowerHistogram`](../../helpers/powerHistogram/classes/PowerHistogram.md)

***

### \_limiter

> **\_limiter**: [`PowerGCRA`](../../powerGCRA/classes/PowerGCRA.md)

***

### \_maxRate

> **\_maxRate**: `number`

***

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

***

### \_minRate

> **\_minRate**: `number`

***

### \_now

> **\_now**: () => `number`

#### Returns

`number`

***

### \_observations

> **\_observations**: `number`

***

### \_onRateChange

> **\_onRateChange**: ((`rate`, `previous`) => `void`) \| `null`

***

### \_quantile

> **\_quantile**: `number`

***

### \_queue

> **\_queue**: [`PowerQueue`](../../helpers/powerQueue/classes/PowerQueue.md)

***

### \_queueCapacity

> **\_queueCapacity**: `number`

***

### \_rate

> **\_rate**: `number`

***

### \_recorded

> **\_recorded**: `number`

***

### \_servo

> **\_servo**: [`PowerServo`](../../helpers/powerServo/classes/PowerServo.md)

***

### \_submitted

> **\_submitted**: `number`

***

### \_targetP99

> **\_targetP99**: `number`

## Accessors

### depth

#### Get Signature

> **get** **depth**(): `number`

Items waiting to be admitted.

##### Returns

`number`

***

### dropped

#### Get Signature

> **get** **dropped**(): `number`

Items `submit()` refused because the queue was full.

**This is the number to alert on.** A flow controller that is dropping is a
flow controller whose rate is too low for the offered load, and nothing else
in `stats()` says so — the queue is bounded by design, so a healthy-looking
depth is exactly what overload looks like.

##### Returns

`number`

***

### latency

#### Get Signature

> **get** **latency**(): [`PowerHistogram`](../../helpers/powerHistogram/classes/PowerHistogram.md)

The underlying `PowerHistogram`, for `snapshot()` and `toJSON()`.

##### Returns

[`PowerHistogram`](../../helpers/powerHistogram/classes/PowerHistogram.md)

***

### limiter

#### Get Signature

> **get** **limiter**(): [`PowerGCRA`](../../powerGCRA/classes/PowerGCRA.md)

The underlying `PowerGCRA`, for `retryAfter()` and direct inspection.

##### Returns

[`PowerGCRA`](../../powerGCRA/classes/PowerGCRA.md)

***

### maxRate

#### Get Signature

> **get** **maxRate**(): `number`

Upper bound on the adaptive rate.

##### Returns

`number`

***

### minRate

#### Get Signature

> **get** **minRate**(): `number`

Lower bound on the adaptive rate. Always greater than 0.

##### Returns

`number`

***

### now

#### Get Signature

> **get** **now**(): () => `number`

The injected clock, exposed so a caller can time work with the same one.

##### Returns

() => `number`

***

### p99

#### Get Signature

> **get** **p99**(): `number` \| `undefined`

The p99 of the **current, partial window** — the samples recorded since the
last `observe()`. `undefined` when the window is empty.

Not a lifetime figure, and deliberately not: see the module docblock on why
a cumulative window makes the loop unable to recover.

##### Returns

`number` \| `undefined`

***

### queue

#### Get Signature

> **get** **queue**(): [`PowerQueue`](../../helpers/powerQueue/classes/PowerQueue.md)

The underlying `PowerQueue`.

##### Returns

[`PowerQueue`](../../helpers/powerQueue/classes/PowerQueue.md)

***

### queueCapacity

#### Get Signature

> **get** **queueCapacity**(): `number`

Bound on the waiting queue.

##### Returns

`number`

***

### rate

#### Get Signature

> **get** **rate**(): `number`

The rate the loop is currently admitting at, in operations per second.

##### Returns

`number`

***

### servo

#### Get Signature

> **get** **servo**(): [`PowerServo`](../../helpers/powerServo/classes/PowerServo.md)

The underlying `PowerServo`, for runtime retuning of the gains.

##### Returns

[`PowerServo`](../../helpers/powerServo/classes/PowerServo.md)

***

### targetP99

#### Get Signature

> **get** **targetP99**(): `number`

The latency setpoint, in milliseconds.

##### Returns

`number`

## Methods

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `void`

Alias for [PowerFlowController#dispose](#dispose-1), for `await using`.

#### Returns

`void`

***

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [PowerFlowController#dispose](#dispose-1), so `using x = new X()`
releases the instance deterministically at scope exit.

#### Returns

`void`

***

### admit()

> **admit**(): `any`

Take the next item, if the rate limiter admits one.

#### Returns

`any`

The item, or `null` when the queue is empty or the GCRA
  refuses. `null` is not an error — refusing is what a rate limiter is for.

***

### clear()

> **clear**(): `void`

Alias for [PowerFlowController#reset](#reset).

Present because `PowerFlowControl` and `PowerQueue` both carry the pair, and
a caller reaching for the obvious word on a flow helper should not get a
`TypeError`. The two are exact synonyms here — unlike on `PowerThrottle` and
`PowerPermitGate`, where `reset()` refills and `clear()` would read as the
opposite, this helper has no refill to confuse it with.

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

Release every resource this instance holds.

Idempotent, and safe to call while the instance is idle. This helper owns no
timer, no listener registry and no `FinalizationRegistry` — the GCRA refills
lazily from a stored timestamp, the histogram is passive, and the servo
advances only when stepped — so this is a **state reset**, not a teardown.
Saying "cancels the interval" here would document work that is not
happening.

#### Returns

`void`

***

### getStats()

> **getStats**(): `object`

Alias for [PowerFlowController#stats](#stats).

#### Returns

`object`

##### admitted

> **admitted**: `number`

##### depth

> **depth**: `number`

##### dropped

> **dropped**: `number`

##### maxRate

> **maxRate**: `number`

##### minRate

> **minRate**: `number`

##### observations

> **observations**: `number`

##### p99

> **p99**: `number` \| `undefined`

##### quantile

> **quantile**: `number`

##### queueCapacity

> **queueCapacity**: `number`

##### rate

> **rate**: `number`

##### recorded

> **recorded**: `number`

##### saturated

> **saturated**: `boolean`

##### submitted

> **submitted**: `number`

##### targetP99

> **targetP99**: `number`

***

### observe()

> **observe**(`dt?`): `number`

Advance the loop by one sample and return the new rate.

Reads the p99 of the window, steps the servo, and writes the result into the
GCRA. The window is then cleared, so the next observation judges the next
window.

**An observation with nothing new to measure does not move the rate.** An
idle loop has no error to correct, and tuning on stale data is how a
controller learns something about a workload that no longer exists — the
same rule `PowerBackpressure` applies to its refill heartbeat.

#### Parameters

##### dt?

`number`

Elapsed time since the last observation, in the same
  unit as the gains. Defaults to the servo's own `dt`.

#### Returns

`number`

The rate after this observation, unchanged when there was
  nothing to measure.

***

### record()

> **record**(`ms`): `void`

Record one operation's latency, in milliseconds.

Negative values are refused rather than clamped: `PowerHistogram.record()`
already refuses them, and a caller passing a negative has a clock problem
that clamping would hide.

#### Parameters

##### ms

`number`

Elapsed time for one admitted operation.

#### Returns

`void`

***

### reset()

> **reset**(): `void`

Discard the queue, the latency window and the learned rate.

The rate returns to the configured `rate`, not to `minRate`: a reset means
"forget what you learned about this workload", and the configured rate is
the caller's own statement about what the workload should get.

In-flight work is **not** forgotten — the GCRA's theoretical arrival time
survives, because the operations it accounts for are still running.

#### Returns

`void`

***

### stats()

> **stats**(): `object`

Current state, as counters.

#### Returns

`object`

##### admitted

> **admitted**: `number`

##### depth

> **depth**: `number`

##### dropped

> **dropped**: `number`

##### maxRate

> **maxRate**: `number`

##### minRate

> **minRate**: `number`

##### observations

> **observations**: `number`

##### p99

> **p99**: `number` \| `undefined`

##### quantile

> **quantile**: `number`

##### queueCapacity

> **queueCapacity**: `number`

##### rate

> **rate**: `number`

##### recorded

> **recorded**: `number`

##### saturated

> **saturated**: `boolean`

##### submitted

> **submitted**: `number`

##### targetP99

> **targetP99**: `number`

***

### submit()

> **submit**(`item`): `boolean`

Offer an item to the controller.

Bounds the queue and counts what it drops. It does **not** consult the rate
limiter — the queue is the buffer and `admit()` is the gate, and conflating
them would make `depth` mean two different things.

#### Parameters

##### item

`any`

Anything. The controller never inspects it.

#### Returns

`boolean`

`true` when the item was queued, `false` when the queue
  was full and the item was dropped.
