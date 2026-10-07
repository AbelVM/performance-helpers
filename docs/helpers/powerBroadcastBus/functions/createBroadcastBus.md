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

`object`

### close

> **close**: (`sub`) => `void`

#### Parameters

##### sub

###### id

`string`

#### Returns

`void`

### dispose

> **dispose**: () => `void`

#### Returns

`void`

### getSlowConsumerIds

> **getSlowConsumerIds**: () => `Set`\<`string`\>

#### Returns

`Set`\<`string`\>

### send

> **send**: (`sub`, `frame`) => `boolean`

#### Parameters

##### sub

###### id

`string`

##### frame

`any`

#### Returns

`boolean`
