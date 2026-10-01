[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerGCRA](../README.md) / PowerGCRAOptions

# Interface: PowerGCRAOptions

## Properties

### burst?

> `optional` **burst?**: `number`

Extra tolerance above the steady-state rate, in
  operations. `0` allows exactly the steady-state spacing; larger values admit
  a short spike of that many extra operations.

***

### now?

> `optional` **now?**: () => `number`

Clock override, for tests and for
  compositions that read the clock once. Ignored by a composition that
  threads its own reading, because an injected clock always wins.

#### Returns

`number`

***

### observability?

> `optional` **observability?**: `boolean` \| [`MetricsCollector`](../../helpers/metrics/classes/MetricsCollector.md)

Opt in to
  metrics: `true` registers this limiter in the shared collector, or pass a collector of
  your own. Off by default, so the common case allocates nothing.

***

### onError?

> `optional` **onError?**: (`arg0`) => `void`

Called when the internal clock
  misbehaves (time moving backwards), instead of throwing.

#### Parameters

##### arg0

`number`

#### Returns

`void`

***

### per?

> `optional` **per?**: `number`

The unit `rate` is measured against, in milliseconds.

***

### rate

> **rate**: `number`

Sustained rate in operations per `per` unit. Must be > 0.
