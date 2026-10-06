[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerWebSocketClient](../README.md) / PowerWebSocketClient

# Class: PowerWebSocketClient

## Constructors

### Constructor

> **new PowerWebSocketClient**(`options?`): `PowerWebSocketClient`

#### Parameters

##### options?

[`WebSocketClientOptions`](../interfaces/WebSocketClientOptions.md) = `{}`

#### Returns

`PowerWebSocketClient`

## Properties

### \_autoReconnect

> **\_autoReconnect**: `boolean`

***

### \_binaryTypeUnsupported

> **\_binaryTypeUnsupported**: `boolean`

***

### \_closedByUser

> **\_closedByUser**: `boolean`

***

### \_codec

> **\_codec**: `"json"` \| `"raw"`

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

### \_heartbeatTimeoutMs

> **\_heartbeatTimeoutMs**: `number`

***

### \_heartbeatTimer

> **\_heartbeatTimer**: `any`

***

### \_highWaterMark

> **\_highWaterMark**: `number`

***

### \_inboundChain

> **\_inboundChain**: `Promise`\<`void`\> \| `null`

***

### \_lastPollInterval

> **\_lastPollInterval**: `number`

***

### \_lastPongAt

> **\_lastPongAt**: `number`

***

### \_lowWaterMark

> **\_lowWaterMark**: `number`

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

### \_nonRetryableCloseCodes

> **\_nonRetryableCloseCodes**: `number`[]

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

#### pause

> **pause**: `Function` \| `null`

#### resume

> **resume**: `Function` \| `null`

***

### \_paused

> **\_paused**: `boolean`

***

### \_pingSentAt

> **\_pingSentAt**: `number`

***

### \_pollBase

> **\_pollBase**: `number`

***

### \_pollMax

> **\_pollMax**: `number`

***

### \_pollTimer

> **\_pollTimer**: `any`

***

### \_reconnectAttempts

> **\_reconnectAttempts**: `number`

***

### \_reconnectBaseMs

> **\_reconnectBaseMs**: `number`

***

### \_reconnectDelay

> **\_reconnectDelay**: `any`

decorrelated-jitter backoff cursor, in ms

***

### \_reconnectExhaustedBy

> **\_reconnectExhaustedBy**: `string` \| `null`

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

### \_reportedBinaryTypeUnsupported

> **\_reportedBinaryTypeUnsupported**: `boolean`

***

### \_socket

> **\_socket**: `any`

***

### \_state

> **\_state**: `0` \| `1` \| `2` \| `3`

***

### \_streamReader

> **\_streamReader**: `ReadableStreamDefaultReader`\<`any`\> \| `null`

***

### \_writer

> **\_writer**: `WritableStreamDefaultWriter`\<`any`\> \| `null`

***

### \_WS

> **\_WS**: `Function`

***

### \_WSStream

> **\_WSStream**: `any`

***

### protocols

> **protocols**: `string` \| `string`[] \| `undefined`

***

### rtt

> **rtt**: [`PowerHistogram`](../../helpers/powerHistogram/classes/PowerHistogram.md)

***

### socketOptions

> **socketOptions**: `object`

#### constructor

> **constructor**: `Function`

The initial value of Object.prototype.constructor is the standard built-in Object constructor.

#### hasOwnProperty()

> **hasOwnProperty**(`v`): `boolean`

Determines whether an object has a property with the specified name.

##### Parameters

###### v

`PropertyKey`

A property name.

##### Returns

`boolean`

#### isPrototypeOf()

> **isPrototypeOf**(`v`): `boolean`

Determines whether an object exists in another object's prototype chain.

##### Parameters

###### v

`Object`

Another object whose prototype chain is to be checked.

##### Returns

`boolean`

#### propertyIsEnumerable()

> **propertyIsEnumerable**(`v`): `boolean`

Determines whether a specified property is enumerable.

##### Parameters

###### v

`PropertyKey`

A property name.

##### Returns

`boolean`

#### toLocaleString()

> **toLocaleString**(): `string`

Returns a date converted to a string using the current locale.

##### Returns

`string`

#### toString()

> **toString**(): `string`

Returns a string representation of an object.

##### Returns

`string`

#### valueOf()

> **valueOf**(): `Object`

Returns the primitive value of the specified object.

##### Returns

`Object`

***

### url

> **url**: `string`

## Accessors

### backpressureMode

#### Get Signature

> **get** **backpressureMode**(): [`BackpressureMode`](../type-aliases/BackpressureMode.md)

Which back-pressure mechanism is in use.

- `'streams'` — a `WebSocketStream` writer is available, so real
  Streams back-pressure applies and `writer.ready` is the signal.
- `'watermark'` — `bufferedAmount` is polled against the configured marks.
- `'none'` — the socket is not open, so neither is active.

##### Returns

[`BackpressureMode`](../type-aliases/BackpressureMode.md)

***

### bufferedAmount

#### Get Signature

> **get** **bufferedAmount**(): `number`

Bytes the socket has buffered and not yet handed to the network.

##### Returns

`number`

***

### isOpen

#### Get Signature

> **get** **isOpen**(): `boolean`

##### Returns

`boolean`

Whether the socket is open and accepting data.

***

### paused

#### Get Signature

> **get** **paused**(): `boolean`

Whether the producer is currently paused for back-pressure.

##### Returns

`boolean`

***

### readyState

#### Get Signature

> **get** **readyState**(): `0` \| `1` \| `2` \| `3`

##### Returns

`0` \| `1` \| `2` \| `3`

The socket's ready state, mirroring the platform
  `WebSocket.readyState` constants (`READY_STATE` above). Spelled as the
  literal union rather than `WebSocketReadyState`, which is a `lib.dom`
  alias - referencing it made the shipped declaration depend on a DOM lib
  that a Node consumer may not have. Two corrections landed here in one
  pass: an earlier revision claimed this was a state *name* and declared it
  `string` (producing 11 "no overlap" diagnostics on every
  `_state === READY_STATE.X` comparison), and the next used the DOM alias.

## Methods

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

Asynchronous disposal hook, so `await using client = new PowerWebSocketClient(…)`
works alongside the synchronous `using`.

**A delegation rather than a graceful path, and that is deliberate.**
`PowerRealtimeHub`'s `asyncDispose` awaits `flush()` first because it has real
pending work; this client's teardown is `close()`, which is synchronous and
already complete. Inventing an awaitable variant of it would be a promise
that resolves immediately and implied a graceful path that does not exist —
the `PowerPool` version drains because it has something to drain.

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

WebSocket close code.

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

Resolves once the socket is open, rejects on a
  failed connect or a connect timeout.

***

### dispose()

> **dispose**(): `void`

Named alias for the `Symbol.dispose` implementation, so callers who do not

want to reach for the symbol still have something to call.

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

***

### off()

> **off**(`type`): `void`

Remove a registered handler.

#### Parameters

##### type

`"message"` \| `"error"` \| `"open"` \| `"close"` \| `"pause"` \| `"resume"`

#### Returns

`void`

***

### on()

> **on**(`type`, `handler`): () => `void`

Register a lifecycle handler.

#### Parameters

##### type

`"message"` \| `"error"` \| `"open"` \| `"close"` \| `"pause"` \| `"resume"`

##### handler

`Function`

#### Returns

An unsubscribe function.

() => `void`

***

### ping()

> **ping**(): `void`

Send an application-level ping. Only useful when the protocol allows it;
otherwise rely on the heartbeat, which uses whatever the transport offers.

#### Returns

`void`

***

### send()

> **send**(`message`, `options?`): `Promise`\<`boolean`\>

Send a message, applying back-pressure.

With the Streams tier this awaits `writer.ready`, so the returned promise
resolves only when the socket has room. With the watermark tier it
resolves as soon as the frame is handed to `send()`, and the *producer* is
expected to honour `onPause`/`onResume` — because at that point the browser
has already buffered it and there is nothing left to await.

#### Parameters

##### message

`any`

##### options?

When the socket is
  over its high-water mark, drop the message instead of queueing it. Use for
  telemetry where a gap is better than growing an unbounded buffer.

###### dropOnBackpressure?

`boolean`

#### Returns

`Promise`\<`boolean`\>

`true` when the frame was handed to the socket.

***

### sendFrame()

> **sendFrame**(`frame`, `options?`): `Promise`\<`boolean`\>

Send an **already-framed** payload, applying the same back-pressure.

This is the correct adapter for `PowerRealtimeHub`: the hub hands its
`send` adapter a frame it has already encoded, and passing that to
[PowerWebSocketClient#send](#send) would try to JSON-serialise the bytes and
corrupt them. Use this when the payload is already a frame, and `send()`
for a plain value.

#### Parameters

##### frame

`Uint8Array`\<`ArrayBufferLike`\>

A payload from `encodeMessage` /
  `frameEncodedJson`.

##### options?

`Object` = `{}`

Same shape as [send](#send).

#### Returns

`Promise`\<`boolean`\>

`true` when the frame was handed to the socket.

***

### stats()

> **stats**(): `object`

Counters plus heartbeat statistics.

#### Returns

`object`
