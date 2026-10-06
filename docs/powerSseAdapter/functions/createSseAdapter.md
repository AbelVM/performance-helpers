[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerSseAdapter](../README.md) / createSseAdapter

# Function: createSseAdapter()

> **createSseAdapter**(`options?`): `object`

Build a `send(subscriber, frame)` adapter for SSE.

The adapter owns the per-subscriber writer lifecycle: it writes each frame
as one SSE `data:` line, awaits back-pressure, and closes the stream when
the hub detaches the subscriber.

## Parameters

### options?

[`SseAdapterOptions`](../interfaces/SseAdapterOptions.md) = `{}`

## Returns

`object`

### close

> **close**: (`arg0`, `arg1`) => `void`

#### Parameters

##### arg0

`object`

##### arg1

`string`

#### Returns

`void`

### send

> **send**: (`arg0`, `arg1`) => `Promise`\<`void`\>

#### Parameters

##### arg0

`object`

##### arg1

`Uint8Array`

#### Returns

`Promise`\<`void`\>
