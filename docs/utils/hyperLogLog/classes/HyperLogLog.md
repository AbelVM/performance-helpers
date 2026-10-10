[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/hyperLogLog](../README.md) / HyperLogLog

# Class: HyperLogLog

HyperLogLog cardinality estimator.

## Constructors

### Constructor

> **new HyperLogLog**(`registerCount?`): `HyperLogLog`

#### Parameters

##### registerCount?

`number` = `DEFAULT_REGISTER_COUNT`

Number of registers. Must be a power of
  two. The relative error is `1.04/sqrt(m)`, so 256 registers give ~6.5 %
  and 1024 give ~3.2 %, at one byte per register.

  **A parameter rather than a constant, because the shipped 64 is a
  deliberate trade rather than a limit.** The audit that raised this
  proposed replacing the sketch outright to reach a usable accuracy; raising
  the register count reaches most of the way there for bytes this library
  can afford, and `bench/claims.js cardinality` measures exactly how far.

#### Returns

`HyperLogLog`

## Properties

### \_alpha

> **\_alpha**: `number`

***

### \_maxRank

> **\_maxRank**: `number`

***

### \_shift

> **\_shift**: `number`

Bits consumed by the bucket index, and the widest rank the remainder can
produce. Both derived from the register count rather than hardcoded, so a
count other than 64 is calibrated rather than merely tolerated.

***

### registerCount

> **registerCount**: `number`

***

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
