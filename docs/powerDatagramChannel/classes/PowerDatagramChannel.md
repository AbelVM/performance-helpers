[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerDatagramChannel](../README.md) / PowerDatagramChannel

# Class: PowerDatagramChannel

A bounded, drop-counting datagram channel.

## Example

```ts
const channel = new PowerDatagramChannel(transport, {
  maxDatagramSizeBytes: 64 * 1024,
  maxQueue: 128,
  onError: (err, ctx) => log.warn({ err, ctx }, 'datagram refused'),
});

channel.send(new Uint8Array([1, 2, 3]));
channel.close();
```

## Constructors

### Constructor

> **new PowerDatagramChannel**(`transport`, `options?`): `PowerDatagramChannel`

#### Parameters

##### transport

`any`

An object with a `send(data)` method and an
  optional `readyState` or `isOpen` property. The transport is used
  as-is; this class does not normalise its state machine.

##### options?

[`PowerDatagramChannelOptions`](../interfaces/PowerDatagramChannelOptions.md) = `...`

#### Returns

`PowerDatagramChannel`

## Properties

### \_bytesOut

> **\_bytesOut**: `number`

***

### \_disposed

> **\_disposed**: `boolean`

***

### \_droppedCount

> **\_droppedCount**: `number`

***

### \_errorCount

> **\_errorCount**: `number`

***

### \_maxDatagramSizeBytes

> **\_maxDatagramSizeBytes**: `number`

Hard ceiling on outbound datagram size, in bytes.

***

### \_maxQueue

> **\_maxQueue**: `number`

Maximum datagrams buffered for sending when the transport is not ready.

***

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

***

### \_onError

> **\_onError**: ((`arg0`, `arg1`) => `void`) \| `null`

***

### \_oversizeCount

> **\_oversizeCount**: `number`

***

### \_queue

> **\_queue**: `any`[]

Datagrams waiting to be sent. A plain array — the class reads `.length`,
`.push` and `.shift` only.

***

### \_sentCount

> **\_sentCount**: `number`

***

### \_transport

> **\_transport**: `any`

## Accessors

### isOpen

#### Get Signature

> **get** **isOpen**(): `boolean`

Whether the underlying transport looks open.

Reads `transport.readyState === 'open'` or `transport.isOpen === true`,
falling back to `true` when neither is present — a transport that does not
expose a state flag is assumed open, because the alternative is refusing
every datagram by default.

##### Returns

`boolean`

## Methods

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

Asynchronous disposal hook (thin wrapper). Forwards to sync disposal.

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [PowerDatagramChannel#dispose](#dispose-1), so `using` works.

#### Returns

`void`

***

### close()

> **close**(): `void`

Close the channel.

Safe to call more than once. Does not close the underlying transport — that
is the caller's responsibility — but stops this class from accepting new
datagrams and flushes the internal queue one last time.

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

Detach listeners and drop the transport reference.

`dispose()` is idempotent.

#### Returns

`void`

***

### flush()

> **flush**(): `number`

Flush the internal queue to the transport.

Called by the owner when the transport transitions to open, or periodically
while it is open. Sends every queued datagram that fits under the size
limit; oversize datagrams already in the queue are counted and discarded.

#### Returns

`number`

The number of datagrams successfully sent.

***

### getStats()

> **getStats**(): `object`

Alias for [stats](#stats).

See `guides/stats-naming.md` for why both spellings exist and why this
method is written out per class.

#### Returns

`object`

***

### send()

> **send**(`datagram`): `boolean`

Send one datagram.

**Two refusals, and they are not the same thing:**

- **Oversize → `TypeError`.** Permanent. No amount of retrying makes a
  datagram smaller, and the refusal is counted in `stats().oversizeDatagrams`
  so a caller can see how often it happens.
- **Not open or queue full → `false`.** Transient. The caller retries. A
  full queue drops the oldest datagram first (`drop-oldest`) and increments
  `stats().dropped`, so the loss is observable.

#### Parameters

##### datagram

`string` \| `ArrayBuffer` \| `ArrayBufferView`\<`ArrayBufferLike`\>

The datagram to send.

#### Returns

`boolean`

`false` when the transport is not ready or the queue is
  full. Throws only for an oversize datagram.

#### Throws

When `datagram` exceeds `maxDatagramSizeBytes`.

***

### stats()

> **stats**(): `object`

Counters and configuration for this channel.

#### Returns

`object`
