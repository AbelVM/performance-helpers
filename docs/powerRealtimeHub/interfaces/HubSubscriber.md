[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerRealtimeHub](../README.md) / HubSubscriber

# Interface: HubSubscriber

## Properties

### \_inflightChain?

> `optional` **\_inflightChain?**: `Promise`\<`void`\> \| `null`

The promise for the send
  currently in flight, **including any follow-up flush it chained**, so
  `flush()` can wait for a subscriber's queue to actually empty rather than
  for one frame.

***

### bytesAcknowledged?

> `optional` **bytesAcknowledged?**: ((`arg0`, `arg1`) => `void`) \| `null`

**WT-004.** The callback the caller supplied at subscribe time, or
  `null` when none was supplied — which is the normal case, because the
  hub's own `bytesSent` is the floor and needs no callback. Invoked
  after the transport has taken the frame, in the same statement that
  increments `bytesSent`, so the two move together.

***

### bytesSent

> **bytesSent**: `number`

Bytes of framed payload handed to this
  subscriber's transport so far. Exact, and free: the frame was built for this
  flush anyway, so this is one addition against an already-computed
  `frame.length`. It is **not** a count of what is sitting in `queue` — see
  [HubSubscriberStat.bytesSent](HubSubscriberStat.md#bytessent).

***

### closed

> **closed**: `boolean`

***

### dropped

> **dropped**: `number`

Messages discarded by the slow-consumer policy.

***

### handler

> **handler**: (`arg0`, `arg1`) => `void`

Invoked with each
  delivered message, after the transport accepted it, plus the subscriber it
  was delivered to. Spelled as a call signature so the two arguments the hub
  passes are checked, and so a handler is callable rather than `Function`.

#### Parameters

##### arg0

`any`

##### arg1

`HubSubscriber`

#### Returns

`void`

***

### id

> **id**: `string`

***

### inFlight

> **inFlight**: `number`

Sends currently awaiting the transport.

***

### maxBatch

> **maxBatch**: `number`

***

### maxQueue

> **maxQueue**: `number`

***

### priority

> **priority**: `number`

Drain order. Higher numbers are delivered
first; `0` is the default and is indistinguishable from a subscriber that
asked for `0`, so the common case stays a stable insertion-order walk.

***

### queue

> **queue**: `HubQueue`

Bounded buffer for this subscriber. A HubQueue - the hub reads
  `.length`, `.push`, `.shift` and `.splice` off it, so a queue typed as an
  abstract buffer (the previous declaration) had no `.length` at any of the
  five places that check it before enqueueing. It is a plain array in fifo
  mode and a `PowerPriorityQueue` behind that surface in priority mode, which
  is why the ordering policy never reaches the flush walk.

***

### slowConsumer

> **slowConsumer**: [`SlowConsumerPolicy`](../type-aliases/SlowConsumerPolicy.md)

***

### topic

> **topic**: `string`

***

### transport?

> `optional` **transport?**: `any`

Opaque handle the caller attached at subscribe
  time (a socket, a stream, a peer id). The hub never reads it; it exists so
  a `send`/`close` adapter can get back to its own connection.
