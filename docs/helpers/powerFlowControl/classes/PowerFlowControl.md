[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerFlowControl](../README.md) / PowerFlowControl

# Class: PowerFlowControl

An adaptive token bucket.

## Example

```ts
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

// On a tick, or on every task completion:
flow.observe(queue.length, elapsedMs);
if (flow.tryConsume(1)) run();
```

## Constructors

### Constructor

> **new PowerFlowControl**(`options?`): `PowerFlowControl`

#### Parameters

##### options?

`number` \| [`PowerFlowControlOptions`](../interfaces/PowerFlowControlOptions.md)

#### Returns

`PowerFlowControl`

## Properties

### \_capacity

> **\_capacity**: `number`

***

### \_disposed

> **\_disposed**: `boolean`

***

### \_initialRate

> **\_initialRate**: `number`

***

### \_lastRefill

> **\_lastRefill**: `number`

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

### \_rate

> **\_rate**: `number`

***

### \_servo

> **\_servo**: [`PowerServo`](../../powerServo/classes/PowerServo.md)

***

### \_tokenRemainder

> **\_tokenRemainder**: `number`

***

### \_tokens

> **\_tokens**: `number`

## Accessors

### capacity

#### Get Signature

> **get** **capacity**(): `number`

The bucket size.

##### Returns

`number`

***

### rate

#### Get Signature

> **get** **rate**(): `number`

The current adaptive refill rate, in tokens per second.

##### Returns

`number`

***

### servo

#### Get Signature

> **get** **servo**(): [`PowerServo`](../../powerServo/classes/PowerServo.md)

The underlying controller, for a caller that wants to retune it at runtime.

Exposed rather than wrapped because the gains are the caller's to set, and a
second set of accessors here would be a second place for them to drift.

##### Returns

[`PowerServo`](../../powerServo/classes/PowerServo.md)

***

### tokens

#### Get Signature

> **get** **tokens**(): `number`

Tokens currently available.

##### Returns

`number`

## Methods

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

***

### addTokens()

> **addTokens**(`n`): `void`

Add tokens directly, bypassing the rate.

Exists for the same reason `PowerThrottle.addTokens` does: a test that has
to wait for a refill is a test that is slow and flaky in the same way.

#### Parameters

##### n

`number`

#### Returns

`void`

***

### clear()

> **clear**(): `void`

Alias for [PowerFlowControl#reset](#reset).

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

#### Returns

`void`

***

### getStats()

> **getStats**(): `object`

Alias for [PowerFlowControl#stats](#stats), matching the rest of the library.

#### Returns

`object`

***

### observe()

> **observe**(`measured`, `dt?`, `disturbance?`): `number`

Feed the controller one measurement and let it move the rate.

#### Parameters

##### measured

`number`

The process variable, in the servo's own
  convention: the controller drives it **toward** `setpoint`, so the output
  rises when `measured` is *below* the setpoint and falls when it is above.

  **Read that sign carefully, because it is the one thing here a caller
  cannot infer.** For flow control the natural quantity to hand a controller
  is the queue depth, and a deep queue must produce a *higher* rate — which
  is the opposite of what passing the depth directly does. Observe the
  **headroom** instead (`capacity - depth`, or `setpoint - depth`), so a deep
  queue reads as a small number and the rate rises. `guides/powerFlowControl.md`
  works this through with numbers.

  Must be finite, exactly as `PowerServo.step()` requires: a NaN measurement
  would poison the integrator permanently, and the bucket would then admit at
  a rate no comparison can catch.

##### dt?

`number`

Elapsed time since the last observation, in the same
  unit as the gains. Defaults to the servo's own `dt`.

##### disturbance?

`number` = `0`

A known input the rate must react to
  before the measurement moves. The feedforward path's argument.

#### Returns

`number`

The new rate.

***

### reset()

> **reset**(): `void`

Discard all state and resume from the configured initial rate.

A state reset, not a teardown: this helper owns no timer and no clock, so
there is nothing to cancel. The interface exists so it can take part in
`using` / `await using` like every other long-lived helper here.

#### Returns

`void`

***

### stats()

> **stats**(): `object`

#### Returns

`object`

Counters. `rate` and `tokens` are live state;
  `observations` counts controller samples, which is the number to alert on
  — a loop that has stopped being fed is a loop whose rate has gone stale.

***

### tryConsume()

> **tryConsume**(`n?`): `boolean`

Try to consume `n` tokens.

#### Parameters

##### n?

`number` = `1`

#### Returns

`boolean`

`true` when the tokens were available.
