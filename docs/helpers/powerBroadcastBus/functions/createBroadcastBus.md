[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerBroadcastBus](../README.md) / createBroadcastBus

# Function: createBroadcastBus()

> **createBroadcastBus**(`options`): `object`

Creates a BroadcastChannel bus with per-frame ack, pending counter with
timeout, and slow-consumer detection.

The bus assigns a sequence number to every frame it posts, tracks pending
acks per receiver, and marks a receiver slow when its pending count exceeds
the threshold or when an ack times out. Slow-consumer policy is driven by
the pending counter, not an invisible queue.

## Parameters

### options

[`PowerBroadcastBusOptions`](../interfaces/PowerBroadcastBusOptions.md)

## Returns

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

### close()

> **close**(`sub`): `void`

#### Parameters

##### sub

`any`

#### Returns

`void`

### dispose()

> **dispose**(): `void`

#### Returns

`void`

### getPendingCounts()

> **getPendingCounts**(): `Map`\<`string`, `number`\>

A snapshot of the per-receiver pending-ack counts.

Exists because of AUD-014. `close()` used to write a `0` into
`receiverPendingCount` for a receiver whose pending sends it had just
cleared, on the reasoning that the count was zero either way — which is
true of the *value* and false of the *entry*. A zero entry is not a state,
it is a leftover: nothing decrements it, because the timers that would
have were cleared, so it survives until the bus is disposed and the map
grows one key per closed subscriber.

That is a pure retention bug with no behavioural symptom, which makes it
invisible to every test written against the public surface — the existing
`close` test asserted only `getSlowConsumerIds()` and passed either way.
This accessor is the smallest thing that makes the retention observable,
and it is the same shape as `getSlowConsumerIds()` for the same reason:
"what is the bus still tracking" is a question an operator debugging a leak
actually asks.

#### Returns

`Map`\<`string`, `number`\>

A copy — mutating it does not affect the bus.

### getSlowConsumerIds()

> **getSlowConsumerIds**(): `Set`\<`string`\>

#### Returns

`Set`\<`string`\>

### send()

> **send**(`sub`, `frame`): `boolean`

#### Parameters

##### sub

`any`

##### frame

`any`

#### Returns

`boolean`
