[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerSlidingWindow](../README.md) / PowerSlidingWindow

# Class: PowerSlidingWindow

## Constructors

### Constructor

> **new PowerSlidingWindow**(`options?`): `PowerSlidingWindow`

#### Parameters

##### options?

#### Returns

`PowerSlidingWindow`

## Properties

### \_timestamps

> **\_timestamps**: [`PowerQueue`](../../powerQueue/classes/PowerQueue.md)

***

### capacity

> **capacity**: `number`

***

### windowMs

> **windowMs**: `number`

## Methods

### available()

> **available**(): `number`

Return how many slots are currently available.

#### Returns

`number`

***

### reset()

> **reset**(): `void`

Reset internal state.

#### Returns

`void`

***

### tryConsume()

> **tryConsume**(`n?`): `boolean`

Try to consume `n` slots (default 1).

#### Parameters

##### n?

`number` = `1`

#### Returns

`boolean`

True if consumption succeeded; false otherwise.
