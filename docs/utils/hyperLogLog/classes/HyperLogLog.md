[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/hyperLogLog](../README.md) / HyperLogLog

# Class: HyperLogLog

HyperLogLog cardinality estimator.

## Constructors

### Constructor

> **new HyperLogLog**(`registerCount?`, `options?`): `HyperLogLog`

#### Parameters

##### registerCount?

`number` = `DEFAULT_REGISTER_COUNT`

Number of registers. Must be a power of
  two.

##### options?

###### sparse?

`boolean`

Enable sparse representation for
  small cardinalities (exact counting until the threshold is reached).

###### sparseThreshold?

`number`

Distinct-count threshold at
  which the sketch converts from sparse to dense. Defaults to
  `registerCount * 4`.

#### Returns

`HyperLogLog`

## Properties

### \_alpha

> **\_alpha**: `number`

***

### \_dense

> **\_dense**: `boolean`

***

### \_maxRank

> **\_maxRank**: `number`

***

### \_shift

> **\_shift**: `number`

***

### \_sparseEnabled

> **\_sparseEnabled**: `boolean`

***

### \_sparseSet

> **\_sparseSet**: `Set`\<`number`\> \| `null`

***

### \_sparseThreshold

> **\_sparseThreshold**: `number`

***

### registerCount

> **registerCount**: `number`

***

### registers

> **registers**: `Uint8Array`\<`ArrayBufferLike`\>

## Accessors

### isDense

#### Get Signature

> **get** **isDense**(): `boolean`

Whether the sketch is currently in dense mode.

##### Returns

`boolean`

## Methods

### addHash()

> **addHash**(`hash`): `void`

Add an element to the estimator.

#### Parameters

##### hash

`any`

#### Returns

`void`

***

### cardinality()

> **cardinality**(): `number`

Estimate the number of distinct elements added.

#### Returns

`number`

***

### reset()

> **reset**(): `void`

Reset all registers to zero and return to sparse phase.

#### Returns

`void`
