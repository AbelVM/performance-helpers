[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerEventBus](../README.md) / PowerEventBus

# Class: PowerEventBus\<T\>

## Template

**T**

## Type Parameters

### T

`T` = `Record`\<`string`, `any`\>

## Constructors

### Constructor

> **new PowerEventBus**\<`T`\>(`options?`): `PowerEventBus`\<`T`\>

#### Parameters

##### options?

`PowerEventBusOptions` = `{}`

`maxListeners` caps listeners per
  event (`0`, the default, is unlimited); `weak` stores them behind
  `WeakRef`.

#### Returns

`PowerEventBus`\<`T`\>

## Properties

### \_eventFinalizationRefs

> **\_eventFinalizationRefs**: `Map`\<`string`, `Set`\<`WeakRef`\<`SubscriberListener`\>\>\>

***

### \_finalizationRefs

> **\_finalizationRefs**: `WeakMap`\<`SubscriberListener`, `Map`\<`string`, `Set`\<`WeakRef`\<`SubscriberListener`\>\>\>\>

***

### \_fr

> **\_fr**: `FinalizationRegistry`\<`EventBusWeakToken`\> \| `null`

***

### \_listeners

> **\_listeners**: `Map`\<`string`, [`EventBusBucket`](../type-aliases/EventBusBucket.md)\>

***

### \_maxListeners

> **\_maxListeners**: `number`

***

### \_weak

> **\_weak**: `boolean`

***

### \_wildcards

> **\_wildcards**: `Map`\<`string`, [`EventBusBucket`](../type-aliases/EventBusBucket.md)\>

## Methods

### \_clearWeakListenerEvent()

> **\_clearWeakListenerEvent**(`event`): `void`

Unregister every weak ref held for one event, and forget the event.

#### Parameters

##### event

`string`

#### Returns

`void`

***

### \_ensureFinalizationRegistry()

> **\_ensureFinalizationRegistry**(): `FinalizationRegistry`\<`EventBusWeakToken`\> \| `null`

Lazily build the `FinalizationRegistry` that prunes collected weak
listeners. Returns `null` when weak mode is off or the runtime has no
`FinalizationRegistry`, which is the signal to skip registration entirely.

#### Returns

`FinalizationRegistry`\<`EventBusWeakToken`\> \| `null`

***

### \_getBucket()

> **\_getBucket**(`event`, `store?`): [`PowerSubscriberSet`](../../powerSubscriberSet/classes/PowerSubscriberSet.md) \| `null`

The live bucket for an event, migrating a legacy plain `Set` of listeners
into a `PowerSubscriberSet` the first time it is read.

Nothing in this module writes a plain `Set`, so the migration branch is not
reachable from here - but `_listeners` is a public-ish field on a
long-lived object and the bus is documented as tolerant of a set that was
replaced externally, so it stays.

#### Parameters

##### event

`string`

##### store?

`Map`\<`string`, [`EventBusBucket`](../type-aliases/EventBusBucket.md)\> = `...`

Defaults to `_listeners`.

#### Returns

[`PowerSubscriberSet`](../../powerSubscriberSet/classes/PowerSubscriberSet.md) \| `null`

***

### \_registerWeakListener()

> **\_registerWeakListener**(`fn`, `event`): `WeakRef`\<`SubscriberListener`\> \| `null`

Track a weak listener with the bus's `FinalizationRegistry`, so the
bookkeeping sets can drop it when it is collected.

#### Parameters

##### fn

`SubscriberListener`

##### event

`string`

#### Returns

`WeakRef`\<`SubscriberListener`\> \| `null`

The registered ref, or `null` when
  weak mode is off or registration failed.

***

### \_unregisterWeakListener()

> **\_unregisterWeakListener**(`fn`, `event?`): `void`

Drop a weak listener's bookkeeping. With no `event`, every event it was
registered against is cleared.

#### Parameters

##### fn

`SubscriberListener`

##### event?

`string`

#### Returns

`void`

***

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

Asynchronous disposal hook (thin wrapper). Forwards to sync disposal.

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [PowerEventBus#dispose](#dispose-1), so `using bus = new PowerEventBus()`
releases the listeners and the finalization registry at scope exit.

#### Returns

`void`

***

### cleanup()

> **cleanup**(): `void`

Cleanup dead weak refs from internal listener sets.
Useful in tests or environments where FinalizationRegistry/GC is unavailable.

#### Returns

`void`

***

### clear()

> **clear**(`event?`): `void`

Clear listeners for an event or all events when called without args.

#### Parameters

##### event?

keyof `T` & `string`

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

Release every listener, and reset the `FinalizationRegistry` so the
registry's retained callbacks become garbage.

Idempotent, and safe to call while the bus is idle. Exists so a bus works
with `using` / `await using` (see the `Symbol.dispose` alias below)
and gives callers an explicit name to call.

#### Returns

`void`

***

### emit()

> **emit**(`event`, `payload?`): `boolean`

Emit an event to all subscribers. Returns true if any listeners were notified.

Errors thrown by listeners are swallowed, and so are rejections from
listeners that returned a promise — an `async` listener that throws will not
reach the process. See notifyListener, which is where both are
observed.

#### Parameters

##### event

keyof `T` & `string`

##### payload?

`any`

#### Returns

`boolean`

***

### emitAsync()

> **emitAsync**(`event`, `payload?`, `options?`): `Promise`\<`boolean`\>

Emit an event to all subscribers and await async listeners.
Supports bounded concurrency so long listener lists can be processed in
batches without flooding the event loop.
Errors thrown or rejected by listeners are swallowed.

#### Parameters

##### event

keyof `T` & `string`

##### payload?

`any`

##### options?

`concurrency` caps how many
  listeners are awaited at once (`Infinity`, the default, is unbounded).

###### concurrency?

`number` = `Infinity`

#### Returns

`Promise`\<`boolean`\>

***

### listeners()

> **listeners**(`event`): `SubscriberListener`[]

Return array of listeners for an event (copy).

#### Parameters

##### event

keyof `T` & `string`

#### Returns

`SubscriberListener`[]

***

### off()

> **off**(`event`, `fn`): `void`

Remove a specific listener for an event.

#### Parameters

##### event

keyof `T` & `string`

Supports wildcard patterns containing `*`.

##### fn

(`payload`) => `void`

#### Returns

`void`

***

### on()

> **on**(`event`, `fn`): () => `void`

Subscribe to an event.

#### Parameters

##### event

keyof `T` & `string`

Event name to subscribe to. Supports
  wildcard patterns containing `*` (e.g. `user:*` matches `user:login`).

##### fn

(`payload`) => `void`

Listener function.

#### Returns

unsubscribe

() => `void`

#### Throws

When `fn` is not a function.

***

### once()

> **once**(`event`, `fn`): () => `void`

Subscribe once to an event. Listener is removed after first invocation.

#### Parameters

##### event

keyof `T` & `string`

Supports wildcard patterns containing `*`.

##### fn

(`payload`) => `void`

#### Returns

unsubscribe

() => `void`

#### Throws

When `fn` is not a function.

***

### reset()

> **reset**(`event?`): `void`

Alias for [PowerEventBus#clear](#clear).

`clear()` here empties the container, and "reset" is a natural second word
for exactly that - so a caller who reaches for `reset()` on this class gets
the obvious thing instead of a `TypeError`. No limiter gets this alias: for
`PowerThrottle` and `PowerPermitGate`, `reset()` *refills* and `clear()`
would read as the opposite, and the two are deliberately not synonyms.

#### Parameters

##### event?

keyof `T` & `string`

Passed through to `clear()`; clears just that
  event's listeners when given, and every listener when omitted.

#### Returns

`void`
