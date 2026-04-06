[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerTTLMap](../README.md) / PowerTTLMap

# Class: PowerTTLMap

## Constructors

### Constructor

> **new PowerTTLMap**(`defaultTTL?`, `options?`): `PowerTTLMap`

#### Parameters

##### defaultTTL?

`number` = `0`

##### options?

#### Returns

`PowerTTLMap`

## Properties

### \_defaultTTL

> **\_defaultTTL**: `number`

***

### \_expirations

> **\_expirations**: `Map`\<`any`, `any`\>

***

### \_map

> **\_map**: `Map`\<`any`, `any`\>

***

### \_onExpire

> **\_onExpire**: `any`

## Accessors

### size

#### Get Signature

> **get** **size**(): `number`

Number of non-expired entries (purges expired entries lazily).

##### Returns

`number`

## Methods

### \_checkExpire()

> **\_checkExpire**(`key`, `entry`): `boolean`

#### Parameters

##### key

`any`

##### entry

`any`

#### Returns

`boolean`

***

### \[iterator\]()

> **\[iterator\]**(): `IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

Default iterator yielding `[key, value]` pairs for non-expired entries.

#### Returns

`IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

***

### clear()

> **clear**(): `void`

Remove all entries.

#### Returns

`void`

***

### delete()

> **delete**(`key`): `boolean`

Delete a key.

#### Parameters

##### key

`any`

#### Returns

`boolean`

***

### entries()

> **entries**(): `IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

Iterate entries [key, value] skipping expired entries.

#### Returns

`IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

***

### forEach()

> **forEach**(`cb`, `thisArg?`): `void`

Call `cb` for each non-expired entry.

#### Parameters

##### cb

`Function`

##### thisArg?

`any`

#### Returns

`void`

***

### get()

> **get**(`key`): `any`

Get a value, returning `undefined` when missing or expired.

#### Parameters

##### key

`any`

#### Returns

`any`

***

### has()

> **has**(`key`): `boolean`

Check whether a key exists and is not expired.

#### Parameters

##### key

`any`

#### Returns

`boolean`

***

### keys()

> **keys**(): `IterableIterator`\<`any`, `any`, `any`\>

Iterate keys of non-expired entries.

#### Returns

`IterableIterator`\<`any`, `any`, `any`\>

***

### set()

> **set**(`key`, `value`, `ttl?`): `PowerTTLMap`

Set a key with optional TTL (ms).

#### Parameters

##### key

`any`

##### value

`any`

##### ttl?

`number`

TTL in milliseconds for this key.

#### Returns

`PowerTTLMap`

***

### touch()

> **touch**(`key`, `ttl?`): `boolean`

Refresh TTL for an existing key. No-op if missing/expired.

#### Parameters

##### key

`any`

##### ttl?

`number`

#### Returns

`boolean`

True when TTL refreshed.

***

### values()

> **values**(): `IterableIterator`\<`any`, `any`, `any`\>

Iterate values of non-expired entries.

#### Returns

`IterableIterator`\<`any`, `any`, `any`\>
