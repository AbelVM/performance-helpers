[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/jsdoc-types](../README.md) / PostMessageOptions

# Interface: PostMessageOptions

## Properties

### awaitResponse?

> `optional` **awaitResponse?**: `boolean`

If true, returns a Promise resolved when a response with a matching `correlationId` is received.

***

### timeout?

> `optional` **timeout?**: `number`

Timeout in milliseconds for `awaitResponse` promises. If omitted, the caller or pool default is used.

***

### workerId?

> `optional` **workerId?**: `string` \| `number`

Optional id of the target worker to prefer when dispatching the message.

***

### zeroCopy?

> `optional` **zeroCopy?**: `boolean`

When true and the message is a plain object, attempt zero-copy transfer (encode to `Uint8Array` and transfer its buffer).
