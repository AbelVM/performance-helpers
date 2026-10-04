[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerRealtimeHub](../README.md) / HubOptions

# Interface: HubOptions

## Properties

### batch?

> `optional` **batch?**: `boolean`

Coalesce messages published within the
  same microtask into a single `send`. Turn off for tests or transports that
  cannot handle several frames at once.

***

### batchDelayMs?

> `optional` **batchDelayMs?**: `number`

Optional macrotask delay before
  flushing, to widen the coalescing window beyond a single microtask.

***

### close?

> `optional` **close?**: (`arg0`, `arg1`) => `void` \| `Promise`\<`void`\>

Optional
  adapter called when the hub closes a subscriber for falling behind or on
  `close()`. Takes the same `(subscriber, reason)` pair as `send` plus why
  it happened - `'unsubscribe'`, `'slow-consumer'` or `'hub-closed'`. The
  published type previously declared one parameter, while the guide, the
  runtime and every test all pass and read two.

#### Parameters

##### arg0

`object`

##### arg1

`string`

#### Returns

`void` \| `Promise`\<`void`\>

***

### codec?

> `optional` **codec?**: `"json"` \| `"raw"`

Payload codec for outgoing frames.

***

### observability?

> `optional` **observability?**: `boolean` \| [`MetricsCollector`](../../helpers/metrics/classes/MetricsCollector.md)

Opt in to
  metrics: `true` registers this helper in the shared collector, or pass a
  collector of your own. Off by default, so the common case allocates nothing.
  See `guides/metrics.md`.

***

### onError?

> `optional` **onError?**: (`arg0`, `arg1`) => `void`

Called when the `send`
  adapter rejects or throws, instead of leaving an unhandled rejection.

#### Parameters

##### arg0

`Error`

##### arg1

`object`

#### Returns

`void`

***

### send

> **send**: (`arg0`, `arg1`) => `void` \| `Promise`\<`void`\>

Required
  transport adapter, called as `send(subscriber, frame)`. Return a promise if
  the transport is async; the hub tracks in-flight sends per subscriber.

  **The `frame` is shared and must be treated as read-only.** RT-006 encodes one
  frame per `(topic, batch)` and hands the same buffer to every subscriber on
  the topic, so a transport that writes into `frame` corrupts every other
  subscriber's message. Copy it if the transport needs to own it.
  `stats().encoded` makes a violation visible: it counts real encodes, so it
  stays at one per flush however many subscribers the topic has.

#### Parameters

##### arg0

`object`

##### arg1

`Uint8Array`

#### Returns

`void` \| `Promise`\<`void`\>
