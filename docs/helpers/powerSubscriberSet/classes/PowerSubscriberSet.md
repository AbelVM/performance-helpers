[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerSubscriberSet](../README.md) / PowerSubscriberSet

# Class: PowerSubscriberSet

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

> **\[iterator\]**(): `ArrayIterator`\<`any`\>

Iterate live listeners in insertion order.

#### Returns

`ArrayIterator`\<`any`\>

***

### add()

> **add**(`fn`): () => `boolean`

Add a listener and return an unsubscribe function.

#### Parameters

##### fn

`any`

#### Returns

() => `boolean`

***

### addOnce()

> **addOnce**(`fn`): () => `boolean`

Add a once listener and return an unsubscribe function.

#### Parameters

##### fn

`any`

#### Returns

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

#### Returns

`boolean`

***

### forEach()

> **forEach**(`fn`): `void`

Iterate live listeners in insertion order and invoke a callback.

#### Parameters

##### fn

`any`

#### Returns

`void`

***

### values()

> **values**(): `any`[]

Return a safe array copy of live listeners.

#### Returns

`any`[]
