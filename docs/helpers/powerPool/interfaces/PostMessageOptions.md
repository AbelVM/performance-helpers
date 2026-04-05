[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerPool](../README.md) / PostMessageOptions

# Interface: PostMessageOptions

## Properties

### awaitResponse?

> `optional` **awaitResponse?**: `boolean`

If true, returns a Promise resolved when a response with a matching `correlationId` is received.

***

### timeout?

> `optional` **timeout?**: `number`

Timeout in milliseconds for `awaitResponse` promises. If omitted, the pool's default is used.

***

### workerId?

> `optional` **workerId?**: `string` \| `number`

Optional id of the target worker to prefer when dispatching the message. If omitted, the pool chooses the least-loaded worker.

***

### zeroCopy?

> `optional` **zeroCopy?**: `boolean`

When true and the message is a plain object, attempt zero-copy transfer (use internal encoding to a Uint8Array and transfer its buffer).
