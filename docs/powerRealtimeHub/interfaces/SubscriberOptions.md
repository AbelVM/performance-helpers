[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerRealtimeHub](../README.md) / SubscriberOptions

# Interface: SubscriberOptions

## Properties

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
