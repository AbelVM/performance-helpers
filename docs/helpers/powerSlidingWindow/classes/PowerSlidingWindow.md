[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerSlidingWindow](../README.md) / PowerSlidingWindow

# Class: PowerSlidingWindow

## Constructors

### Constructor

> **new PowerSlidingWindow**(`options?`): `PowerSlidingWindow`

#### Parameters

##### options?

`PowerSlidingWindowOptions` = `{}`

`capacity` defaults to 1
  and `windowMs` to one second.

#### Returns

`PowerSlidingWindow`

## Properties

### \_now

> **\_now**: () => `number`

Clock for this limiter, and whether it was explicitly injected. See
`resolveLimiterNow` for why the flag is load-bearing: an injected clock
must outrank a value threaded in by a composition.

#### Returns

`number`

***

### \_nowExplicit

> **\_nowExplicit**: `boolean`

***

### \_timestamps

> **\_timestamps**: [`PowerQueue`](../../powerQueue/classes/PowerQueue.md)

***

### capacity

> **capacity**: `number`

***

### windowMs

> **windowMs**: `number`

## Methods

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [dispose](#dispose-1), so `using x = new PowerSlidingWindow(…)` releases
it deterministically at scope exit.

#### Returns

`void`

***

### available()

> **available**(`options?`): `number`

Return how many slots are currently available.

#### Parameters

##### options?

`LimiterNowOptions` = `{}`

Per-call
  clock override.

#### Returns

`number`

***

### clear()

> **clear**(): `void`

Alias for [PowerSlidingWindow#reset](#reset).

This one is a true synonym and not a uniformity gesture: `reset()` here
*is* a clear - it empties the timestamp queue. Contrast the limiters, where
`reset()` restores a usable state (refilled tokens, re-closed circuit) and
`clear()` would read as the exact opposite.

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

Release every resource this instance holds.

The window holds a `PowerQueue` of timestamps and a clock reference. Neither
is a timer or a subscription, so this clears the recorded history and
re-seeds the clock rather than cancelling anything — a half-elapsed window
is dropped rather than left to keep admitting what it had already counted.

Present so this helper can take part in `using` / `await using` and DI
teardown like every other long-lived helper in the library.

#### Returns

`void`

***

### reset()

> **reset**(): `void`

Drop every recorded timestamp, returning the window to fully available.

#### Returns

`void`

***

### tryConsume()

> **tryConsume**(`n?`, `options?`): `boolean`

Try to consume `n` slots (default 1).

#### Parameters

##### n?

`number` = `1`

##### options?

`LimiterNowOptions` = `{}`

Per-call
  clock override.

#### Returns

`boolean`

True if consumption succeeded; false otherwise.
