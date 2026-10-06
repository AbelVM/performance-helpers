[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerRealtimeHub](../README.md) / HubSubscriberStat

# Interface: HubSubscriberStat

## Properties

### bytesSent

> **bytesSent**: `number`

Bytes handed to this subscriber's transport so
  far. **This is the per-subscriber share of `stats().bytesOut`, and the two
  reconcile exactly:** the hub adds `frame.length` to both in the same
  statement, so `bytesOut === Σ list[].bytesSent` for any set of subscribers
  still attached. RT-026 replaced a field called `bytesQueued` here that was
  initialised to `0` and never written, which made it the second
  permanently-zero advertisement in a class whose entire job is to let a
  caller see how far behind a subscriber is. The reconcilable pair is what
  makes this one real; a counter nothing can check is decoration.

***

### dropped

> **dropped**: `number`

***

### id

> **id**: `string`

***

### inFlight

> **inFlight**: `number`

***

### maxQueue

> **maxQueue**: `number`

***

### priority

> **priority**: `number`

Drain order, so a caller reading `stats().list`
  can see *why* a subscriber was served before another rather than guessing
  from `queued`/`inFlight`. Reflected from the stored subscriber, not
  re-derived: it is a value the caller supplied, so reporting it back is the
  honest thing and recomputing it would be inventing a value.

***

### queued

> **queued**: `number`

Messages waiting for this subscriber right now.

***

### slowConsumer

> **slowConsumer**: [`SlowConsumerPolicy`](../type-aliases/SlowConsumerPolicy.md)

***

### topic

> **topic**: `string`
