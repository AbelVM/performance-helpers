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

### \_fr

> **\_fr**: `any`

***

### \_listeners

> **\_listeners**: `Map`\<`string`, `Set`\<`any`\>\>

***

### \_maxListeners

> **\_maxListeners**: `number`

***

### \_weak

> **\_weak**: `boolean`

## Methods

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

Subscribe to an event.

#### Parameters

##### event

`string`

##### fn

(`payload`) => `void`

#### Returns

unsubscribe

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
