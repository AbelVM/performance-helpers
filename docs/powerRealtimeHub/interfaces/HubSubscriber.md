[**performance-helpers**](../../README.md)

---

[performance-helpers](../../README.md) / [powerRealtimeHub](../README.md) / HubSubscriber

# Interface: HubSubscriber

## Properties

### \_inflightChain?

> `optional` **\_inflightChain?**: `Promise`\<`void`\> \| `null`

The promise for the send
currently in flight, **including any follow-up flush it chained**, so
`flush()` can wait for a subscriber's queue to actually empty rather than
for one frame.

---

### bytesQueued

> **bytesQueued**: `number`

Approximate bytes currently buffered.

---

### closed

> **closed**: `boolean`

---

### dropped

> **dropped**: `number`

Messages discarded by the slow-consumer policy.

---

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

---

### id

> **id**: `string`

---

### inFlight

> **inFlight**: `number`

Sends currently awaiting the transport.

---

### maxBatch

> **maxBatch**: `number`

---

### maxQueue

> **maxQueue**: `number`

---

### queue

> **queue**: `any`[]

Bounded buffer for this subscriber. A plain array - the hub reads
`.length`, `.push`, `.shift` and `.splice` off it, so a queue typed as an
abstract buffer (the previous declaration) had no `.length` at any of the
five places that check it before enqueueing.

---

### slowConsumer

> **slowConsumer**: [`SlowConsumerPolicy`](../type-aliases/SlowConsumerPolicy.md)

---

### topic

> **topic**: `string`

---

### transport?

> `optional` **transport?**: `any`

Opaque handle the caller attached at subscribe
time (a socket, a stream, a peer id). The hub never reads it; it exists so
a `send`/`close` adapter can get back to its own connection.
