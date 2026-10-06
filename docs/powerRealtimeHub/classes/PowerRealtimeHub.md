[**performance-helpers**](../../README.md)

***

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

***

### \_batchDelayMs

> **\_batchDelayMs**: `number`

***

### \_close

> **\_close**: ((`arg0`, `arg1`) => `void` \| `Promise`\<`void`\>) \| `null`

***

### \_closed

> **\_closed**: `boolean`

***

### \_codec

> **\_codec**: `"json"` \| `"raw"`

***

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

#### encoded

> **encoded**: `number` = `0`

#### published

> **published**: `number` = `0`

#### rateLimited

> **rateLimited**: `number` = `0`

***

### \_flushScheduled

> **\_flushScheduled**: `boolean`

***

### \_flushTimer

> **\_flushTimer**: `any`

***

### \_frameMemo

> **\_frameMemo**: `Uint8Array`\<`ArrayBufferLike`\> \| `null`

***

### \_frameMemoFirst

> **\_frameMemoFirst**: `any`

***

### \_frameMemoLast

> **\_frameMemoLast**: `any`

***

### \_frameMemoLength

> **\_frameMemoLength**: `number`

***

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

***

### \_onError

> **\_onError**: ((`arg0`, `arg1`) => `void`) \| `null`

***

### \_rateLimit

> **\_rateLimit**: [`PowerRateLimit`](../../helpers/powerRateLimit/classes/PowerRateLimit.md) \| `null`

***

### \_retained

> **\_retained**: `Map`\<`string`, `any`[]\>

***

### \_send

> **\_send**: (`arg0`, `arg1`) => `void` \| `Promise`\<`void`\>

#### Parameters

##### arg0

`object`

##### arg1

`Uint8Array`

#### Returns

`void` \| `Promise`\<`void`\>

***

### \_subs

> **\_subs**: `Map`\<`string`, [`HubSubscriber`](../interfaces/HubSubscriber.md)\>

***

### \_topics

> **\_topics**: `Map`\<`string`, `Map`\<`string`, [`HubSubscriber`](../interfaces/HubSubscriber.md)\>\>

## Methods

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

Asynchronous disposal hook: **flush what is pending, then close.**

This is the graceful half of the pair, and it exists because `close()` is not
graceful — it clears the pending batch along with everything else. A hub
configured with `batchDelayMs > 0` can be holding frames that have been
`publish`ed but not yet sent, and `using` at scope exit would drop them. So
`await using` gets the frames out first.

Deliberately the same shape as `PowerPool`'s: drain, swallow drain failures,
then tear down. The swallowing is not carelessness — a `finally` in a
disposal path must leave the instance closed even if the flush fails, and
leaving it open would be worse than losing the flush.

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

***

### close()

> **close**(): `void`

Close every subscription and release timers. The hub cannot be reused.

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

Named alias for the `Symbol.dispose` implementation, so callers who do not

want to reach for the symbol still have something to call.

#### Returns

`void`

***

### flush()

> **flush**(): `Promise`\<`void`\>

Flush every pending message immediately, bypassing batching.

#### Returns

`Promise`\<`void`\>

Resolves once all subscribers have been drained.

***

### getStats()

> **getStats**(): [`HubStats`](../interfaces/HubStats.md) & `object`

Alias for [stats](#stats).

See `guides/stats-naming.md` for why both spellings exist and why this
method is written out per class.

#### Returns

[`HubStats`](../interfaces/HubStats.md) & `object`

***

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

***

### stats()

> **stats**(): [`HubStats`](../interfaces/HubStats.md) & `object`

Snapshot of counters and per-subscriber state.

`subscribers` is the live *count*, and the per-subscriber array is `list`.
The declared return previously intersected `subscribers: Array<object>`
onto `HubStats`, which is how the hub ended up publishing a type saying
`subscribers` was an array of records - a number at runtime.

#### Returns

[`HubStats`](../interfaces/HubStats.md) & `object`

***

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

***

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

***

### \_validateAcknowledged()

> `static` **\_validateAcknowledged**(`fn`): ((`arg0`, `arg1`) => `void`) \| `null`

Validate a `bytesAcknowledged` callback supplied to [subscribe](#subscribe).

WT-004. `bytesAcknowledged` is transport-reported per stream and is a
strictly better figure than the hub's own `bytesSent` when the connection
is over HTTP/2 — it counts bytes the peer has actually acknowledged, not
bytes handed to the adapter. But it is **not** a replacement: it is only
available on transports that report it, and on others it is absent. So the
hub keeps `bytesSent` as the floor and exposes this as an **optional**
callback the caller wires up at subscribe time.

The shape is a function rather than a number, because the value moves:
a number captured at subscribe time would be stale by the next flush.
The callback is invoked **after** the transport has taken the frame, in the
same place `bytesSent` is incremented, so the two move together.

#### Parameters

##### fn

`any`

#### Returns

((`arg0`, `arg1`) => `void`) \| `null`

The callback, or `null`
  when the caller supplied `null` or `undefined` — both are the "not
  supplied" sentinel, and the field is typed `function | null` so a caller
  passing `null` explicitly gets the no-op rather than an error.

#### Throws

When `fn` is not a function and not `null`.

#### Static

***

### \_validatePriority()

> `static` **\_validatePriority**(`priority`): `number`

Validate a `priority` value supplied to [subscribe](#subscribe).

Extracted from `subscribe` because that method was already at the
cyclomatic-complexity ceiling and this check is its own branch — and
because the rule it enforces is worth stating once rather than inline.

`priority` is a drain order, and the failure mode it guards against is
specifically the silent one: a non-finite value coerces to `NaN`, which
compares unequal to everything, so `Array.sort` lands the subscriber in an
arbitrary position without throwing. The caller would get a wrong-order
delivery with no error, months after the subscribe that accepted it.

#### Parameters

##### priority

`any`

#### Returns

`number`

A finite number. `0` when the caller omitted it.

#### Throws

When `Number(priority)` is not finite.

#### Static
