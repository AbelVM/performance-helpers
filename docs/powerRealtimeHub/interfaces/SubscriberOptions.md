[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerRealtimeHub](../README.md) / SubscriberOptions

# Interface: SubscriberOptions

## Properties

### bytesAcknowledged?

> `optional` **bytesAcknowledged?**: ((`arg0`, `arg1`) => `void`) \| `null`

**WT-004.** Optional callback reporting bytes the transport has
  *acknowledged* for this subscriber, as opposed to bytes the hub handed
  over. Transport-reported per stream, so on HTTP/2 it matches the hub's
  own `bytesSent`; on transports that do not report it the callback is
  simply not supplied and the hub keeps `bytesSent` as the floor. Invoked
  after the transport has taken the frame, in the same statement that
  increments `bytesSent`, so the two move together. The hub does not
  validate the number the callback reports — it is the caller's transport,
  and the hub's job is to call it, not to audit it.

***

### id?

> `optional` **id?**: `string`

Stable identifier; generated when omitted.

***

### maxBatch?

> `optional` **maxBatch?**: `number`

Maximum messages coalesced into one send.

***

### maxQueue?

> `optional` **maxQueue?**: `number`

Maximum messages buffered for this
  subscriber before the slow-consumer policy applies. `0` disables queueing
  entirely: a full-queue condition is evaluated immediately, which is the
  right setting when delivery is fire-and-forget.

***

### priority?

> `optional` **priority?**: `number`

Drain order. Higher numbers are delivered
first within a topic on the next flush; `0` is the default and is
indistinguishable from a subscriber that asked for `0`, so the common
case stays a stable insertion-order walk. A non-finite value is rejected
at subscribe time, because it would coerce to `NaN` and sort to an
arbitrary position silently.

***

### slowConsumer?

> `optional` **slowConsumer?**: [`SlowConsumerPolicy`](../type-aliases/SlowConsumerPolicy.md)

Policy applied
  when `maxQueue` is exceeded.

***

### transport?

> `optional` **transport?**: `any`

Carried through to the stored
[HubSubscriber](HubSubscriber.md) untouched, for the caller's own `send`/`close`
adapters to use.
