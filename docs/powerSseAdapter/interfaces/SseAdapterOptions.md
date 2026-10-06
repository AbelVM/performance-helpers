[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerSseAdapter](../README.md) / SseAdapterOptions

# Interface: SseAdapterOptions

## Properties

### createResponse?

> `optional` **createResponse?**: (`arg0`) => `Response`

Required in the
  browser. Receives the subscriber record and must return an SSE `Response`
  whose body is a `WritableStream`. When omitted the adapter falls back to
  Node's `ServerResponse` shape if `subscriber.transport` exposes
  `writeHead`/`write`/`end`.

#### Parameters

##### arg0

`object`

#### Returns

`Response`

***

### onError?

> `optional` **onError?**: (`arg0`, `arg1`) => `void`

Called when a write
  to the stream throws, instead of leaving an unhandled rejection.

#### Parameters

##### arg0

`Error`

##### arg1

`object`

#### Returns

`void`
