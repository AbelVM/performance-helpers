[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerSubscriberSet](../README.md) / PowerSubscriberSet

# Class: PowerSubscriberSet

PowerSubscriberSet

Shared subscriber set helper used by event buses and observable stores.
Supports optional weak references, once-listeners, and max listener counts.

 PowerSubscriberSet

## Constructors

### Constructor

> **new PowerSubscriberSet**(`options?`): `PowerSubscriberSet`

#### Parameters

##### options?

###### maxListeners?

`number`

###### weak?

`boolean`

#### Returns

`PowerSubscriberSet`

## Properties

### \_finalization

> **\_finalization**: `any`

***

### \_listeners

> **\_listeners**: `Set`\<`any`\>

***

### \_maxListeners

> **\_maxListeners**: `number`

***

### \_onceMap

> **\_onceMap**: `WeakMap`\<`object`, `any`\>

***

### \_weak

> **\_weak**: `boolean`

## Accessors

### size

#### Get Signature

> **get** **size**(): `number`

Number of currently live listeners.

##### Returns

`number`

## Methods

### \_cleanup()

> **\_cleanup**(): `void`

Remove dead weak refs from the set.

#### Returns

`void`

***

### \_deref()

> **\_deref**(`entry`): `any`

#### Parameters

##### entry

`any`

#### Returns

`any`

***

### \_makeEntry()

> **\_makeEntry**(`fn`): `any`

#### Parameters

##### fn

`any`

#### Returns

`any`

***

### \[iterator\]()

> **\[iterator\]**(): `Generator`\<`any`, `void`, `unknown`\>

Iterate live listeners in insertion order.

#### Returns

`Generator`\<`any`, `void`, `unknown`\>

#### Yields

***

### add()

> **add**(`fn`): () => `boolean`

Add a listener and return an unsubscribe function.

#### Parameters

##### fn

`any`

Listener function or WeakRef when `weak` mode is enabled.

#### Returns

Unsubscribe function that removes the listener.

() => `boolean`

***

### addOnce()

> **addOnce**(`fn`): () => `boolean`

Add a once listener and return an unsubscribe function.
The original listener will be removed after the first invocation.

#### Parameters

##### fn

`Function`

Listener function.

#### Returns

Unsubscribe function.

() => `boolean`

***

### clear()

> **clear**(): `void`

Clear all listeners.

#### Returns

`void`

***

### delete()

> **delete**(`fn`): `boolean`

Delete a listener by original function or once-wrapper.

#### Parameters

##### fn

`any`

Original listener function or its WeakRef wrapper.

#### Returns

`boolean`

`true` if a listener was removed, otherwise `false`.

***

### forEach()

> **forEach**(`fn`): `void`

Iterate live listeners in insertion order and invoke a callback.

#### Parameters

##### fn

(`listener`) => `void`

Callback invoked for each live listener.

#### Returns

`void`

***

### values()

> **values**(): `Function`[]

Return a safe array copy of live listeners.

#### Returns

`Function`[]

Array of live listener functions.
