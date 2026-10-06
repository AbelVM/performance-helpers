[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerWebTransportAdapter](../README.md) / createWebTransportAdapter

# Function: createWebTransportAdapter()

> **createWebTransportAdapter**(`session`): `Promise`\<\{ `close?`: (`code`, `reason`) => `void`; `kind`: `"stream"`; `readable`: `ReadableStream`; `writable`: `WritableStream`; \}\>

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

## Returns

`Promise`\<\{ `close?`: (`code`, `reason`) => `void`; `kind`: `"stream"`; `readable`: `ReadableStream`; `writable`: `WritableStream`; \}\>

A socket object compatible with PowerSocketAdapter.

## Since

2.0.0
