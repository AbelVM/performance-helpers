[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerEventBus](../README.md) / PowerEventBus

# Class: PowerEventBus

## Constructors

### Constructor

> **new PowerEventBus**(`options?`): `PowerEventBus`

#### Parameters

##### options?

\{ `maxListeners?`: `number`; `weak?`: `boolean`; \} \| `undefined`

#### Returns

`PowerEventBus`

## Properties

### \_finalizationRefs

> **\_finalizationRefs**: `WeakMap`\<`object`, `any`\>

***

### \_fr

> **\_fr**: `any`

***

### \_listeners

> **\_listeners**: `Map`\<`any`, `any`\>

***

### \_maxListeners

> **\_maxListeners**: `number`

***

### \_weak

> **\_weak**: `boolean`

## Methods

### \_ensureFinalizationRegistry()

> **\_ensureFinalizationRegistry**(): `any`

#### Returns

`any`

***

### \_getBucket()

> **\_getBucket**(`event`): [`PowerSubscriberSet`](../../powerSubscriberSet/classes/PowerSubscriberSet.md) \| `null`

#### Parameters

##### event

`any`

#### Returns

[`PowerSubscriberSet`](../../powerSubscriberSet/classes/PowerSubscriberSet.md) \| `null`

***

### \_registerWeakListener()

> **\_registerWeakListener**(`fn`, `event`): () => `void`

Subscribe to an event.

#### Parameters

##### fn

(`payload`) => `void`

##### event

`string`

#### Returns

unsubscribe

() => `void`

***

### \_unregisterWeakListener()

> **\_unregisterWeakListener**(`fn`): `void`

#### Parameters

##### fn

`any`

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

`string`

#### Returns

`void`

***

### emit()

> **emit**(`event`, `payload?`): `boolean`

Emit an event to all subscribers. Returns true if any listeners were notified.
Errors thrown by listeners are swallowed.

#### Parameters

##### event

`string`

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

`string`

##### payload?

`any`

##### options?

###### concurrency?

`number` = `Infinity`

#### Returns

`Promise`\<`boolean`\>

***

### listeners()

> **listeners**(`event`): `Function`[]

Return array of listeners for an event (copy).

#### Parameters

##### event

`string`

#### Returns

`Function`[]

***

### off()

> **off**(`event`, `fn`): `void`

Remove a specific listener for an event.

#### Parameters

##### event

`string`

##### fn

(`payload`) => `void`

#### Returns

`void`

***

### on()

> **on**(`event`, `fn`): () => `void`

#### Parameters

##### event

`any`

##### fn

`any`

#### Returns

() => `void`

***

### once()

> **once**(`event`, `fn`): () => `void`

Subscribe once to an event. Listener is removed after first invocation.

#### Parameters

##### event

`string`

##### fn

(`payload`) => `void`

#### Returns

unsubscribe

() => `void`
