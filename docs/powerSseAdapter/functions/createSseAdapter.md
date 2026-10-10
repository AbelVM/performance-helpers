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

### lastEventId

> **lastEventId**: (`sub`) => `string` \| `null`

The `Last-Event-ID` a subscriber sent when it connected, or `null`.

`null` means a first connect — there is nothing to resume from. A string
means the client reconnected after a gap and is telling the server where it
got to; the caller replays from there.

#### Parameters

##### sub

`object`

#### Returns

`string` \| `null`

### lastSentId

> **lastSentId**: (`sub`) => `number`

The id of the last event written to a subscriber, or `0` if none.

The counterpart to lastEventId: where the *server* has got to, as
against where the *client* got to. The difference between the two is exactly
the size of the gap a reconnect has to replay.

#### Parameters

##### sub

`object`

#### Returns

`number`

### register

> **register**: (`sub`) => `void`

Register a subscriber with the adapter.

AUD-025. Reads the `Last-Event-ID` the client sent, so a caller wiring this
into a hub can replay from it. **The adapter deliberately does not replay.**
It holds no buffer of past frames — it is a `send(sub, frame)` bridge, and a
replay buffer is the message source's concern, not the transport's. What the
adapter owes the caller is the resume *point*, exposed as `lastEventId` on
the subscriber record and through lastEventId; without it the caller
cannot know where the client got to, and the gap is unfixable from above.

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
