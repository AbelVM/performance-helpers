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
is a timer or a subscription, so this clears the recorded history rather than
cancelling anything — a half-elapsed window is dropped rather than left to
keep admitting what it had already counted.

Present so this helper can take part in `using` / `await using` and DI
teardown like every other long-lived helper in the library.

**`clear()` then `shrink()`, and both matter.** `clear()` is O(1) where the
drain this used to do — `while (length > 0) shift()` — is O(n) in the number
of timestamps, so a window holding a full `capacity` of entries paid for
every one of them on teardown. `shrink()` is the half that was missing
entirely: without it the ring stayed allocated at its grown capacity for the
life of the instance, which defeats the point of a dispose. Measured with
`capacity: 8192` and 5000 recorded timestamps, `dispose()` left **8192 slots
retained**; it now returns the queue to
`POWER_QUEUE_INITIAL_CAPACITY`.

The **clock is not re-seeded**, contrary to what this comment used to say.
`_now` is the caller's injected clock and `_nowExplicit` records that it was
injected, so replacing either would discard caller configuration rather than
release a resource. There is no accumulated clock state here to clear.

#### Returns

`void`

***

### reset()

> **reset**(): `void`

Drop every recorded timestamp, returning the window to fully available.

**The ring buffer is deliberately *not* shrunk here**, even though `clear`
and `dispose` both shrink. The distinction is logical against physical:
`reset()` puts a live window back to empty, and it may be called on a hot
path (clearing a per-tenant window between requests), where reallocating
the ring on every call would be worse than holding it. `dispose()` is
teardown, where the caller has finished with the instance entirely and
anything still allocated is waste. Shrinking on reset would make the cheap
case expensive to fix the expensive one.

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
