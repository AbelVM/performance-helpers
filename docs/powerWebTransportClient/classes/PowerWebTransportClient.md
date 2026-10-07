[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerWebTransportClient](../README.md) / PowerWebTransportClient

# Class: PowerWebTransportClient

RT-002: a `PowerWebTransportClient` that mirrors the `PowerWebSocketClient`
public API over WebTransport streams.

The transport differences this hides from callers:

- **Back-pressure** is the stream's `ready` promise, not `bufferedAmount`.
- **Heartbeat** is application-level: a small frame sent on the writable
  stream, with a deadline armed on the readable side.
- **Reconnection** is the same decorrelated-jitter shape as the WebSocket
  client, because the hub and the caller should not have to branch.

## Example

```ts
const client = new PowerWebTransportClient({
  url: 'https://example.test/feed',
  onMessage: (msg) => hub.send(msg),
});
client.connect();
```

## Constructors

### Constructor

> **new PowerWebTransportClient**(`options?`): `PowerWebTransportClient`

#### Parameters

##### options?

[`WebTransportClientOptions`](../interfaces/WebTransportClientOptions.md) = `{}`

#### Returns

`PowerWebTransportClient`

## Properties

### \_autoReconnect

> **\_autoReconnect**: `boolean`

***

### \_closedByUser

> **\_closedByUser**: `boolean`

***

### \_codec

> **\_codec**: `"json"` \| `"raw"`

***

### \_connectionGeneration

> **\_connectionGeneration**: `number`

***

### \_connectTimeoutMs

> **\_connectTimeoutMs**: `number`

***

### \_connectTimer

> **\_connectTimer**: `any`

***

### \_counters

> **\_counters**: `object`

#### decodeErrors

> **decodeErrors**: `number` = `0`

#### drops

> **drops**: `number` = `0`

#### heartbeats

> **heartbeats**: `number` = `0`

#### heartbeatTimeouts

> **heartbeatTimeouts**: `number` = `0`

#### oversizeFrames

> **oversizeFrames**: `number` = `0`

#### received

> **received**: `number` = `0`

#### reconnects

> **reconnects**: `number` = `0`

#### sent

> **sent**: `number` = `0`

***

### \_heartbeatDeadline

> **\_heartbeatDeadline**: `any`

***

### \_heartbeatIntervalMs

> **\_heartbeatIntervalMs**: `number`

***

### \_heartbeatSentAt

> **\_heartbeatSentAt**: `number`

***

### \_heartbeatTimeoutMs

> **\_heartbeatTimeoutMs**: `number`

***

### \_heartbeatTimer

> **\_heartbeatTimer**: `any`

***

### \_inboundTransform

> **\_inboundTransform**: `TransformStream`\<`any`, `any`\> \| `undefined`

***

### \_maxPayloadSizeBytes

> **\_maxPayloadSizeBytes**: `number`

***

### \_maxReconnectAttempts

> **\_maxReconnectAttempts**: `number`

***

### \_maxReconnectElapsedMs

> **\_maxReconnectElapsedMs**: `number`

***

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

***

### \_on

> **\_on**: `object`

#### close

> **close**: `Function` \| `null`

#### error

> **error**: `Function` \| `null`

#### message

> **message**: `Function` \| `null`

#### open

> **open**: `Function` \| `null`

***

### \_pumpAbort

> **\_pumpAbort**: `AbortController` \| `null`

***

### \_reader

> **\_reader**: `ReadableStreamDefaultReader`\<`any`\> \| `null`

***

### \_reconnectAttempts

> **\_reconnectAttempts**: `number`

***

### \_reconnectBaseMs

> **\_reconnectBaseMs**: `number`

***

### \_reconnectDelay

> **\_reconnectDelay**: `any`

***

### \_reconnectMaxMs

> **\_reconnectMaxMs**: `number`

***

### \_reconnectOnHeartbeatTimeout

> **\_reconnectOnHeartbeatTimeout**: `boolean`

***

### \_reconnectStartedAt

> **\_reconnectStartedAt**: `number` \| `null`

***

### \_reconnectTimer

> **\_reconnectTimer**: `any`

***

### \_state

> **\_state**: `0` \| `1` \| `2` \| `3`

***

### \_transport

> **\_transport**: `any`

***

### \_writer

> **\_writer**: `WritableStreamDefaultWriter`\<`any`\> \| `null`

***

### \_WT

> **\_WT**: `Function`

***

### rtt

> **rtt**: [`PowerHistogram`](../../helpers/powerHistogram/classes/PowerHistogram.md)

***

### url

> **url**: `string`

## Accessors

### backpressureMode

#### Get Signature

> **get** **backpressureMode**(): [`BackpressureMode`](../type-aliases/BackpressureMode.md)

##### Returns

[`BackpressureMode`](../type-aliases/BackpressureMode.md)

***

### isOpen

#### Get Signature

> **get** **isOpen**(): `boolean`

##### Returns

`boolean`

***

### readyState

#### Get Signature

> **get** **readyState**(): `0` \| `1` \| `2` \| `3`

##### Returns

`0` \| `1` \| `2` \| `3`

## Methods

### \_startStreamPump()

> **\_startStreamPump**(`generation`): `Promise`\<`void`\>

#### Parameters

##### generation

`number`

#### Returns

`Promise`\<`void`\>

***

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

Asynchronous disposal hook.

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

***

### close()

> **close**(`code?`, `reason?`): `void`

Close the connection and stop reconnecting.

#### Parameters

##### code?

`number` = `1000`

Close code.

##### reason?

`string` = `''`

Human-readable reason.

#### Returns

`void`

***

### connect()

> **connect**(): `Promise`\<`void`\>

Open the connection. Safe to call again to reconnect deliberately.

#### Returns

`Promise`\<`void`\>

***

### dispose()

> **dispose**(): `void`

Named alias for `Symbol.dispose`.

#### Returns

`void`

***

### getStats()

> **getStats**(): `object`

Alias for [stats](#stats).

#### Returns

`object`

***

### off()

> **off**(`type`): `void`

Remove a registered handler.

#### Parameters

##### type

`"message"` \| `"error"` \| `"open"` \| `"close"`

#### Returns

`void`

***

### on()

> **on**(`type`, `handler`): () => `void`

Register a lifecycle handler.

#### Parameters

##### type

`"message"` \| `"error"` \| `"open"` \| `"close"`

##### handler

`Function`

#### Returns

() => `void`

***

### ping()

> **ping**(): `void`

Send an application-level ping.

#### Returns

`void`

***

### send()

> **send**(`message`, `options?`): `Promise`\<`boolean`\>

Send a message, applying back-pressure.

#### Parameters

##### message

`any`

##### options?

###### dropOnBackpressure?

`boolean`

#### Returns

`Promise`\<`boolean`\>

`true` when the frame was handed to the transport.

***

### sendFrame()

> **sendFrame**(`frame`, `options?`): `Promise`\<`boolean`\>

Send an already-framed payload.

#### Parameters

##### frame

`Uint8Array`\<`ArrayBufferLike`\>

##### options?

`Object` = `{}`

#### Returns

`Promise`\<`boolean`\>

***

### stats()

> **stats**(): `object`

Counters plus heartbeat statistics.

#### Returns

`object`
