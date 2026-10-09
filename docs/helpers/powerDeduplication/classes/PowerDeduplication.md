[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerDeduplication](../README.md) / PowerDeduplication

# Class: PowerDeduplication

PowerDeduplication

Time-windowed deduplicator. Tracks keys seen within a TTL window and
prevents re-emitting/reprocessing the same key within that window.

 PowerDeduplication

## Constructors

### Constructor

> **new PowerDeduplication**(`options?`): `PowerDeduplication`

#### Parameters

##### options?

`number` \| `PowerDeduplicationOptions`

#### Returns

`PowerDeduplication`

## Properties

### \_disposed

> **\_disposed**: `boolean`

***

### \_keys

> **\_keys**: `Map`\<`any`, `number`\>

***

### \_maxKeys

> **\_maxKeys**: `number`

***

### \_now

> **\_now**: () => `number`

#### Returns

`number`

***

### \_ttl

> **\_ttl**: `number`

## Accessors

### length

#### Get Signature

> **get** **length**(): `number`

##### Returns

`number`

***

### size

#### Get Signature

> **get** **size**(): `number`

##### Returns

`number`

## Methods

### \_prune()

> **\_prune**(`now`): `void`

#### Parameters

##### now

`number`

#### Returns

`void`

***

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

***

### clear()

> **clear**(): `void`

Clear all keys.

#### Returns

`void`

***

### delete()

> **delete**(`key`): `boolean`

Remove key from dedup set.

#### Parameters

##### key

`any`

#### Returns

`boolean`

***

### dispose()

> **dispose**(): `void`

#### Returns

`void`

***

### has()

> **has**(`key`): `boolean`

Test if key is duplicate. If not seen (or expired), mark it as seen and return false.
If seen within TTL, return true.

#### Parameters

##### key

`any`

#### Returns

`boolean`

***

### isEmpty()

> **isEmpty**(): `boolean`

#### Returns

`boolean`

***

### mark()

> **mark**(`key`): `void`

Mark key as seen regardless of previous state.

#### Parameters

##### key

`any`

#### Returns

`void`

***

### reset()

> **reset**(): `void`

Alias for clear.

#### Returns

`void`
