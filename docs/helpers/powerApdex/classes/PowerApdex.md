[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerApdex](../README.md) / PowerApdex

# Class: PowerApdex

## Constructors

### Constructor

> **new PowerApdex**(`options?`): `PowerApdex`

#### Parameters

##### options?

[`PowerApdexOptions`](../interfaces/PowerApdexOptions.md)

`target` is required in practice: the
  constructor throws a `TypeError` without it. The parameter stays optional
  because that throw is the documented way a missing `target` is reported,
  and `new PowerApdex()` must stay callable to reach it.

#### Returns

`PowerApdex`

## Properties

### \_disposed

> **\_disposed**: `boolean`

***

### \_frustrated

> **\_frustrated**: `number`

***

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

***

### \_satisfied

> **\_satisfied**: `number`

***

### \_target

> **\_target**: `number`

***

### \_tolerance

> **\_tolerance**: `number`

***

### \_tolerating

> **\_tolerating**: `number`

## Accessors

### frustrated

#### Get Signature

> **get** **frustrated**(): `number`

Number of samples recorded above `tolerance`.

##### Returns

`number`

***

### satisfied

#### Get Signature

> **get** **satisfied**(): `number`

Number of samples recorded at or below `target`.

##### Returns

`number`

***

### target

#### Get Signature

> **get** **target**(): `number`

The configured satisfied threshold.

##### Returns

`number`

The SLO in the same unit `record()` takes
  (milliseconds by convention). Required: there is no default, because a
  guessed threshold would score against the wrong line and still look like a
  real number.

***

### tolerance

#### Get Signature

> **get** **tolerance**(): `number`

The configured tolerating threshold.

##### Returns

`number`

The upper bound of the tolerating
  class. Must be `>= target`; a smaller value would make the tolerating class
  empty and the arithmetic negative.

***

### tolerating

#### Get Signature

> **get** **tolerating**(): `number`

Number of samples recorded above `target` and at or below `tolerance`.

##### Returns

`number`

***

### total

#### Get Signature

> **get** **total**(): `number`

Total samples recorded.

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

### clear()

> **clear**(): `PowerApdex`

Alias for [PowerApdex#reset](#reset).

#### Returns

`PowerApdex`

***

### dispose()

> **dispose**(): `void`

Detach from metrics and zero the counts.

Owns no timer and no listener registry — it is three integers — so this is
a **state reset**, not a teardown. The interface exists so the helper takes
part in `using` / `await using` like every other long-lived helper here.

#### Returns

`void`

***

### getStats()

> **getStats**(): `object`

Compatibility alias for [PowerApdex#stats](#stats). See `guides/stats-naming.md`.

#### Returns

`object`

##### frustrated

> **frustrated**: `number`

##### satisfied

> **satisfied**: `number`

##### score

> **score**: `number` \| `undefined`

##### target

> **target**: `number`

##### tolerance

> **tolerance**: `number`

##### tolerating

> **tolerating**: `number`

##### total

> **total**: `number`

***

### merge()

> **merge**(`other`): `PowerApdex`

Fold another scorer's counts into this one.

Exact, unlike a sketch merge — three integers add. That is what makes a
per-worker or per-shard scorer aggregatable into a process-level one
without the boundary error a rank query would introduce.

#### Parameters

##### other

`PowerApdex`

Must use the same `target` and `tolerance`. A
  mismatch is a configuration error rather than a silent average: the
  classes are defined by the thresholds, so counts taken against different
  thresholds are not the same measurement and adding them produces a number
  that means nothing.

#### Returns

`PowerApdex`

***

### record()

> **record**(`ms`): `PowerApdex`

Record one completed request's latency.

#### Parameters

##### ms

`number`

Latency in the same unit as `target`. Must be finite and
  non-negative, or `+Infinity` for a request that never completed — which
  lands in **frustrated**, the class it belongs to. `NaN` and a negative
  both throw: a latency that cannot be read is not a slow request, and
  filing it as one would move the score for a reason that has nothing to do
  with the service.

#### Returns

`PowerApdex`

***

### reset()

> **reset**(): `PowerApdex`

Zero the counts. The thresholds are configuration and survive.

#### Returns

`PowerApdex`

***

### score()

> **score**(): `number` \| `undefined`

The APDEX score, or `undefined` when nothing has been recorded.

`undefined` rather than `0` and rather than `1`: an empty scorer has no
score, and both of the numbers a caller might default to would read as a
measurement. Same convention as `PowerHistogram.percentile()` on an empty
sketch.

#### Returns

`number` \| `undefined`

A value in `[0, 1]`.

***

### stats()

> **stats**(): `object`

Counters plus the thresholds they were taken against.

The thresholds are in the snapshot deliberately, the way `PowerGCRA.stats()`
reports its configuration: a score is meaningless without the line it was
measured against, and a dashboard that has to remember which threshold
produced a series is a dashboard that will eventually plot two different
SLOs on one axis.

#### Returns

`object`

##### frustrated

> **frustrated**: `number`

##### satisfied

> **satisfied**: `number`

##### score

> **score**: `number` \| `undefined`

##### target

> **target**: `number`

##### tolerance

> **tolerance**: `number`

##### tolerating

> **tolerating**: `number`

##### total

> **total**: `number`
