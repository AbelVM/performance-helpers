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

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

***

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

A metrics registration is released here for the same reason the ring is: the
collector holds a closure over this instance, so leaving it registered means
a disposed window is sampled forever, and one still answers `stats()`
afterwards so nothing fails visibly.

#### Returns

`void`

***

### getStats()

> **getStats**(): `object`

Alias for [stats](#stats).

See `guides/stats-naming.md` for why both spellings exist and why this
method is written out per class.

#### Returns

`object`

##### available

> **available**: `number`

##### capacity

> **capacity**: `number`

##### used

> **used**: `number`

##### windowMs

> **windowMs**: `number`

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

### stats()

> **stats**(): `object`

Serializable snapshot of the window's configuration and current occupancy.

**It prunes first, and that is what makes `used` mean anything.** Nothing
evicts an expired timestamp except a prune, so a window that has gone quiet
still holds every entry it ever recorded. Reading `_timestamps.length`
directly would therefore report a window as full long after the events
behind it fell out of it — the same failure a stale token count is on
`PowerThrottle`, and wrong in the same direction: a dashboard showing a
saturated window that will in fact admit the request.

Pruning is **not** strictly read-only here, and that is safe to say plainly:
it can only remove timestamps that have already left the window, so it cannot
change any future admission decision. `available()` has pruned on every read
for the same reason and longer; this is not a new hazard, it is the existing
one being visible from a second angle.

#### Returns

`object`

##### available

> **available**: `number`

##### capacity

> **capacity**: `number`

##### used

> **used**: `number`

##### windowMs

> **windowMs**: `number`

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
