[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerDefer](../README.md) / PowerDefer

# Class: PowerDefer

## Constructors

### Constructor

> **new PowerDefer**(): `PowerDefer`

#### Returns

`PowerDefer`

## Properties

### \_settled

> **\_settled**: `boolean`

***

### \_status

> **\_status**: `string`

***

### promise

> **promise**: `Promise`\<`any`\>

## Accessors

### fulfilled

#### Get Signature

> **get** **fulfilled**(): `boolean`

Convenience boolean: true if resolved successfully

##### Returns

`boolean`

***

### rejected

#### Get Signature

> **get** **rejected**(): `boolean`

Convenience boolean: true if rejected

##### Returns

`boolean`

***

### settled

#### Get Signature

> **get** **settled**(): `boolean`

Whether the deferred has been settled.

##### Returns

`boolean`

***

### status

#### Get Signature

> **get** **status**(): `"pending"` \| `"fulfilled"` \| `"rejected"`

Status of the deferred: 'pending' | 'fulfilled' | 'rejected'

##### Returns

`"pending"` \| `"fulfilled"` \| `"rejected"`

## Methods

### reject()

> **reject**(`err`): `void`

Reject the deferred promise. No-op if already settled.

#### Parameters

##### err

`any`

#### Returns

`void`

***

### resolve()

> **resolve**(`value`): `void`

Resolve the deferred promise. No-op if already settled.

#### Parameters

##### value

`any`

#### Returns

`void`
