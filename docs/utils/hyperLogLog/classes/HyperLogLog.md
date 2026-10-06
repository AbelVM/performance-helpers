[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/hyperLogLog](../README.md) / HyperLogLog

# Class: HyperLogLog

HyperLogLog cardinality estimator.

## Constructors

### Constructor

> **new HyperLogLog**(): `HyperLogLog`

#### Returns

`HyperLogLog`

## Properties

### registers

> **registers**: `Uint8Array`\<`ArrayBufferLike`\>

## Methods

### addHash()

> **addHash**(`hash`): `void`

Add an element to the estimator. The argument may be a raw value: it is
finalised internally, so `addHash(0)`, `addHash(1)` ... estimate correctly
rather than saturating.

#### Parameters

##### hash

`any`

A 32-bit hash value, or any value coercible to one.

#### Returns

`void`

***

### cardinality()

> **cardinality**(): `number`

Estimate the number of distinct elements added.

#### Returns

`number`

Cardinality estimate.

***

### reset()

> **reset**(): `void`

Reset all registers to zero.

#### Returns

`void`
