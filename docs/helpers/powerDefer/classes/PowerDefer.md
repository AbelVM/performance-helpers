[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerDefer](../README.md) / PowerDefer

# Class: PowerDefer

Deferred promise primitive.
Separates a `Promise` from its `resolve`/`reject` functions.
Useful for barriers and manual promise coordination.

## Example

```ts
const d = new PowerDefer();
setTimeout(() => d.resolve(42), 10);
await d.promise; // 42
```

## Constructors

### Constructor

> **new PowerDefer**(): `PowerDefer`

#### Returns

`PowerDefer`

## Properties

### \_reject

> **\_reject**: (`err`) => `void`

#### Parameters

##### err

`any`

#### Returns

`void`

***

### \_resolve

> **\_resolve**: (`v`) => `void`

#### Parameters

##### v

`any`

#### Returns

`void`

***

### \_settled

> **\_settled**: `boolean`

***

### promise

> **promise**: `Promise`\<`any`\>

## Accessors

### settled

#### Get Signature

> **get** **settled**(): `boolean`

Whether the deferred has been settled.

##### Returns

`boolean`

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
