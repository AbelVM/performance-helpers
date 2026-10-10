[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerSseAdapter](../README.md) / SseSubscriber

# Interface: SseSubscriber

## Properties

### abort

> **abort**: `AbortController` \| `null`

***

### closed

> **closed**: `boolean`

***

### id

> **id**: `string`

***

### lastEventId

> **lastEventId**: `string` \| `null`

The `Last-Event-ID` the client sent when
  it (re)connected, or `null` on a first connect. This is the resume point;
  replaying from it is the caller's job, because the adapter holds no buffer.

***

### seq

> **seq**: `number`

Monotonic per-subscriber event id, emitted as the
  SSE `id:` field. See frameToSseLine.

***

### writer

> **writer**: `WritableStreamDefaultWriter`\<`any`\> \| `null`
