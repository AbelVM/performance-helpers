[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerMessagePort](../README.md) / PowerMessagePort

# Class: PowerMessagePort

## Constructors

### Constructor

> **new PowerMessagePort**(`port`, `options?`): `PowerMessagePort`

#### Parameters

##### port

`MessagePort`

An open or opening `MessagePort`. The adapter
  attaches listeners immediately; a port that is not yet `open` queues
  messages until it is, which is the platform's normal behaviour.

##### options?

[`PowerMessagePortOptions`](../interfaces/PowerMessagePortOptions.md) = `...`

#### Returns

`PowerMessagePort`

## Properties

### \_disposed

> **\_disposed**: `boolean`

***

### \_errorCount

> **\_errorCount**: `number`

***

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

***

### \_onClose

> **\_onClose**: (() => `void`) \| `null`

***

### \_onCloseHandler

> **\_onCloseHandler**: (() => `void`) \| `undefined`

***

### \_onError

> **\_onError**: ((`arg0`) => `void`) \| `null`

***

### \_onMessage

> **\_onMessage**: ((`arg0`, `arg1`) => `void`) \| `null`

***

### \_onMessageErrorHandler

> **\_onMessageErrorHandler**: ((`e`) => `void`) \| `undefined`

***

### \_onMessageHandler

> **\_onMessageHandler**: ((`e`) => `void`) \| `undefined`

***

### \_port

> **\_port**: `MessagePort`

***

### \_receivedCount

> **\_receivedCount**: `number`

***

### \_sentCount

> **\_sentCount**: `number`

***

### \_state

> **\_state**: `"open"` \| `"closed"`

## Methods

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [PowerMessagePort#dispose](#dispose-1), so `using` works.

#### Returns

`void`

***

### close()

> **close**(): `void`

The hub's `close(sub)` adapter.

Safe to call more than once, and safe on a port that closed first.

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

Detach every listener and drop the port reference.

Required rather than tidy: a `MessagePort` outliving its adapter keeps the
handler closure alive, and a peer table that never disposes leaks one
adapter per port for the life of the process.

`dispose()` is idempotent.

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

### send()

> **send**(`_sub`, `frame`): `boolean`

The hub's `send(sub, frame)` adapter.

Posts the hub's encoded `Uint8Array` frame to the port. The frame is the
hub's own buffer, handed over by reference — the platform serialises
synchronously, so a transport that wrote into it would corrupt every other
subscriber on the same topic. Copy it if you need to retain it.

#### Parameters

##### \_sub

`object`

The subscriber record (unused; present so the hub's
  `send(sub, frame)` signature is satisfied).

##### frame

`Uint8Array`\<`ArrayBufferLike`\>

The hub's encoded frame.

#### Returns

`boolean`

`false` when the port is already disposed. Throws only
  for a platform error.

***

### stats()

> **stats**(): `object`

A minimal snapshot for the metrics collector.

#### Returns

`object`
