[**performance-helpers**](../../../README.md)

---

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

---

### \_nowExplicit

> **\_nowExplicit**: `boolean`

---

### \_timestamps

> **\_timestamps**: [`PowerQueue`](../../powerQueue/classes/PowerQueue.md)

---

### capacity

> **capacity**: `number`

---

### windowMs

> **windowMs**: `number`

## Methods

### available()

> **available**(`options?`): `number`

Return how many slots are currently available.

#### Parameters

##### options?

#### Returns

`number`

---

### clear()

> **clear**(): `void`

Alias for [PowerSlidingWindow#reset](#reset).

This one is a true synonym and not a uniformity gesture: `reset()` here
_is_ a clear - it empties the timestamp queue. Contrast the limiters, where
`reset()` restores a usable state (refilled tokens, re-closed circuit) and
`clear()` would read as the exact opposite.

#### Returns

`void`

---

### reset()

> **reset**(): `void`

Drop every recorded timestamp, returning the window to fully available.

#### Returns

`void`

---

### tryConsume()

> **tryConsume**(`n?`, `options?`): `boolean`

Try to consume `n` slots (default 1).

#### Parameters

##### n?

`number` = `1`

##### options?

#### Returns

`boolean`

True if consumption succeeded; false otherwise.
