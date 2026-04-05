[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerPool](../README.md) / PowerPoolShutdownError

# Class: PowerPoolShutdownError

Error used when the pool is shutdown and pending promises are rejected.

## Extends

- `Error`

## Constructors

### Constructor

> **new PowerPoolShutdownError**(`message?`): `PowerPoolShutdownError`

#### Parameters

##### message?

`string` = `'PowerPool has been shut down'`

#### Returns

`PowerPoolShutdownError`

#### Overrides

`Error.constructor`

## Properties

### message

> **message**: `string`

#### Inherited from

`Error.message`

***

### name

> **name**: `string`

#### Inherited from

`Error.name`

***

### stack?

> `optional` **stack?**: `string`

#### Inherited from

`Error.stack`
