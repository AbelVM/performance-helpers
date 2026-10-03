[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerServo](../README.md) / PowerServo

# Class: PowerServo

## Constructors

### Constructor

> **new PowerServo**(`options?`): `PowerServo`

#### Parameters

##### options?

`PowerServoOptions` = `{}`

#### Returns

`PowerServo`

## Properties

### \_defaultDt

> **\_defaultDt**: `number`

Default `dt` for [PowerServo#step](#step), in whatever time unit the gains
are expressed in. `1` makes a controller that ignores wall time behave
correctly for a fixed-rate tick, and callers on a real clock should pass
their own elapsed time instead.

***

### \_derivative

> **\_derivative**: `number`

***

### \_derivativeFilter

> **\_derivativeFilter**: `number`

First-order low-pass coefficient on the derivative term, in `[0, 1)`.
`0` filters nothing (raw differentiation); values near `1` make the
derivative very slow. Ignored when `kd` is `0`.

***

### \_error

> **\_error**: `number`

***

### \_feedforward

> **\_feedforward**: `number` \| `Function` \| `null`

***

### \_feedforwardGain

> **\_feedforwardGain**: `number`

Static-gain form of the feedforward path, applied to `disturbance` when
`feedforward` is not a function. Setting it implies
`feedforward: (d) => d * gain`.

***

### \_integral

> **\_integral**: `number`

***

### \_kd

> **\_kd**: `number`

***

### \_ki

> **\_ki**: `number`

***

### \_kp

> **\_kp**: `number`

***

### \_output

> **\_output**: `number`

***

### \_previousMeasured

> **\_previousMeasured**: `number` \| `null`

***

### \_saturated

> **\_saturated**: `boolean`

***

### max

> **max**: `number`

***

### min

> **min**: `number`

***

### setpoint

> **setpoint**: `number`

## Accessors

### derivative

#### Get Signature

> **get** **derivative**(): `number`

The filtered derivative term from the last step, per unit time.

##### Returns

`number`

***

### error

#### Get Signature

> **get** **error**(): `number`

The error from the last step, `setpoint - measured`.

##### Returns

`number`

***

### integral

#### Get Signature

> **get** **integral**(): `number`

The accumulated integral term, in error·time units. Exposed because a
controller whose integral keeps climbing while the output sits still at a
bound is the windup bug, and it is otherwise invisible.

##### Returns

`number`

***

### output

#### Get Signature

> **get** **output**(): `number`

The control output from the last [PowerServo#step](#step).

Reported rather than relied on: `step()` returns it too. This exists so a
caller wiring the output into something on a *different* tick — a field
read, a stats block — does not have to keep its own copy of a number it
computed.

##### Returns

`number`

***

### saturated

#### Get Signature

> **get** **saturated**(): `boolean`

Whether the last step was clamped by `min` or `max`.

##### Returns

`boolean`

## Methods

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [PowerServo#dispose](#dispose-1), so `using s = new PowerServo()`
releases the instance deterministically at scope exit.

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

Release this instance's state.

**A state reset, not a teardown.** This class owns no timer, no listener and
no `FinalizationRegistry` — `dt` is an argument, by design — so there is
nothing to cancel and nothing to unregister. It exists so a
`PowerServo` held for a process lifetime can take part in `using` /
`await using` or a DI teardown alongside every other long-lived helper here.

The instance stays usable afterwards, deliberately: calling it a teardown
and then having `reset()` throw on a second call would document work that
does not happen.

#### Returns

`void`

***

### reset()

> **reset**(): `void`

Restore the controller to its constructed state: no accumulated integral, no
remembered measurement, no output.

Bounds, gains and setpoint are configuration and survive, because a caller
resetting a loop between workloads wants the tuning they already chose.

#### Returns

`void`

***

### step()

> **step**(`measured`, `dt?`, `disturbance?`): `number`

Advance the loop by one sample and return the control output.

Three positional arguments rather than an options object because this is
called on a tick: a literal `{ dt, disturbance }` would allocate on every
step, and the whole point of a control helper is that it is cheap enough to
leave in a hot path.

#### Parameters

##### measured

`number`

The process variable `y`. Must be finite.

##### dt?

`number`

Elapsed time since the last step, **in the same unit
  as the gains**. Defaults to the constructor's `dt`, which is `1`.

##### disturbance?

`number` = `0`

A known input the output must react to
  *before* the error moves. This is the feedforward path's argument.

#### Returns

`number`

The control output `u`, clamped to `[min, max]`.
