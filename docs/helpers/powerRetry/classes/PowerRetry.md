[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerRetry](../README.md) / PowerRetry

# Class: PowerRetry

## Constructors

### Constructor

> **new PowerRetry**(`options?`): `PowerRetry`

Create a configured retry helper.

#### Parameters

##### options?

`Object` = `{}`

Default options applied to every `run()` invocation.

#### Returns

`PowerRetry`

## Properties

### \_options

> **\_options**: `Object`

## Methods

### run()

> **run**(`fn`, `options?`): `Promise`\<`any`\>

Instance method that runs `fn` with the configured options merged with
any per-call `options` provided.

#### Parameters

##### fn

`Function`

##### options?

`Object` = `{}`

#### Returns

`Promise`\<`any`\>

***

### run()

> `static` **run**(`fn`, `options?`): `Promise`\<`any`\>

#### Parameters

##### fn

`any`

##### options?

#### Returns

`Promise`\<`any`\>
