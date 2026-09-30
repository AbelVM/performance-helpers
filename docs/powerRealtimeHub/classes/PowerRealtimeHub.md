[**performance-helpers**](../../README.md)

---

[performance-helpers](../../README.md) / [powerRealtimeHub](../README.md) / PowerRealtimeHub

# Class: PowerRealtimeHub

## Constructors

### Constructor

> **new PowerRealtimeHub**(`options`): `PowerRealtimeHub`

#### Parameters

##### options

[`HubOptions`](../interfaces/HubOptions.md)

`send` is required; the constructor throws
without it, so the parameter is not defaulted.

#### Returns

`PowerRealtimeHub`

## Properties

### \_batch

> **\_batch**: `boolean`

---

### \_batchDelayMs

> **\_batchDelayMs**: `number`

---

### \_close

> **\_close**: ((`arg0`, `arg1`) => `void` \| `Promise`\<`void`\>) \| `null`

---

### \_closed

> **\_closed**: `boolean`

---

### \_codec

> **\_codec**: `"json"` \| `"raw"`

---

### \_counters

> **\_counters**: `object`

#### bytesOut

> **bytesOut**: `number` = `0`

#### delivered

> **delivered**: `number` = `0`

#### disconnected

> **disconnected**: `number` = `0`

#### dropped

> **dropped**: `number` = `0`

#### published

> **published**: `number` = `0`

---

### \_flushScheduled

> **\_flushScheduled**: `boolean`

---

### \_flushTimer

> **\_flushTimer**: `any`

---

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

---

### \_now

> **\_now**: () => `number`

Get a high-resolution timestamp in milliseconds since the epoch.

This function prefers `performance.timeOrigin + performance.now()` when
available and reasonably close to `Date.now()` to provide higher
resolution timestamps. On Node.js it uses `process.hrtime.bigint()` with an
epoch offset when available. Falls back to `Date.now()` if nothing
better is available or when offsets appear to diverge (e.g. in some
test harnesses).

#### Returns

`number`

Milliseconds since epoch (floating point for higher resolution).

---

### \_onError

> **\_onError**: ((`arg0`, `arg1`) => `void`) \| `null`

---

### \_retained

> **\_retained**: `Map`\<`string`, `any`[]\>

---

### \_send

> **\_send**: (`arg0`, `arg1`) => `void` \| `Promise`\<`void`\>

#### Parameters

##### arg0

`object`

##### arg1

`Uint8Array`

#### Returns

`void` \| `Promise`\<`void`\>

---

### \_subs

> **\_subs**: `Map`\<`string`, [`HubSubscriber`](../interfaces/HubSubscriber.md)\>

---

### \_topics

> **\_topics**: `Map`\<`string`, `Map`\<`string`, [`HubSubscriber`](../interfaces/HubSubscriber.md)\>\>

## Methods

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

---

### close()

> **close**(): `void`

Close every subscription and release timers. The hub cannot be reused.

#### Returns

`void`

---

### dispose()

> **dispose**(): `void`

Named alias for the `Symbol.dispose` implementation, so callers who do not

want to reach for the symbol still have something to call.

#### Returns

`void`

---

### flush()

> **flush**(): `Promise`\<`void`\>

Flush every pending message immediately, bypassing batching.

#### Returns

`Promise`\<`void`\>

Resolves once all subscribers have been drained.

---

### publish()

> **publish**(`topic`, `message`, `options?`): `number`

Publish a message to every subscriber of a topic.

Delivery is asynchronous: the message is queued per subscriber and handed to
the transport on the next flush. A `send` adapter that throws is reported
through `onError` and does not affect other subscribers.

#### Parameters

##### topic

`string`

##### message

`any`

##### options?

###### retain?

`boolean`

Keep the message for a subscriber
that subscribes later. Intended for a small, fixed set of topics such as
config changes; the retained log is not bounded per subscriber, so do not
use it for an unbounded feed.

#### Returns

`number`

The number of subscribers the message was queued for.

---

### stats()

> **stats**(): [`HubStats`](../interfaces/HubStats.md) & `object`

Snapshot of counters and per-subscriber state.

`subscribers` is the live _count_, and the per-subscriber array is `list`.
The declared return previously intersected `subscribers: Array<object>`
onto `HubStats`, which is how the hub ended up publishing a type saying
`subscribers` was an array of records - a number at runtime.

#### Returns

[`HubStats`](../interfaces/HubStats.md) & `object`

---

### subscribe()

> **subscribe**(`topic`, `handler`, `options?`): () => `boolean`

Subscribe to a topic.

#### Parameters

##### topic

`string`

Topic name.

##### handler

(`arg0`, `arg1`) => `void`

Invoked with each delivered
message. Throwing is isolated and reported through `onError`.

##### options?

[`SubscriberOptions`](../interfaces/SubscriberOptions.md) = `{}`

#### Returns

An unsubscribe function. Returns `false` if
the subscription was already gone.

() => `boolean`

---

### unsubscribe()

> **unsubscribe**(`id`): `boolean`

Remove a subscription.

#### Parameters

##### id

`string`

Subscriber id.

#### Returns

`boolean`

`true` when a subscription was removed.
