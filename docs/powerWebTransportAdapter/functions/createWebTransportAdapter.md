[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerWebTransportAdapter](../README.md) / createWebTransportAdapter

# Function: createWebTransportAdapter()

> **createWebTransportAdapter**(`session`): `Promise`\<\{ `kind`: `string`; `readable`: `ReadableStream`\<`any`\>; `writable`: `WritableStream`\<`any`\>; `[asyncDispose]`: `Promise`\<`void`\>; `[dispose]`: `void`; `close`: `void`; `dispose`: `void`; \}\>

Wrap a `WebTransport` session in a stream socket that decodes inbound
frames.

**No connection is opened here.** The caller is expected to have
constructed and configured the `WebTransport` already (including
`createBidirectionalStreams: true` in the options). The only thing this
function does is call `session.createBidirectionalStream()` and wrap the
result.

## Parameters

### session

`WebTransport`

A live `WebTransport` with bidirectional
  streams enabled.
  A socket object compatible with PowerSocketAdapter.

## Returns

`Promise`\<\{ `kind`: `string`; `readable`: `ReadableStream`\<`any`\>; `writable`: `WritableStream`\<`any`\>; `[asyncDispose]`: `Promise`\<`void`\>; `[dispose]`: `void`; `close`: `void`; `dispose`: `void`; \}\>

## Since

2.0.0
