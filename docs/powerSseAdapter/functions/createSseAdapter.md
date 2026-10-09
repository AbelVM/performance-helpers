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

### \[asyncDispose\]

> **\[asyncDispose\]**: () => `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

### \[dispose\]

> **\[dispose\]**: () => `void` = `dispose`

#### Returns

`void`

### close

> **close**: (`sub`) => `void`

#### Parameters

##### sub

`object`

#### Returns

`void`

### dispose

> **dispose**: () => `void`

#### Returns

`void`

### register

> **register**: (`sub`) => `void`

#### Parameters

##### sub

`object`

#### Returns

`void`

### send

> **send**: (`sub`, `frame`) => `Promise`\<`void`\>

#### Parameters

##### sub

`object`

##### frame

`Uint8Array`\<`ArrayBufferLike`\>

#### Returns

`Promise`\<`void`\>
