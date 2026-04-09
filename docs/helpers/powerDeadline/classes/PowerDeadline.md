[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerDeadline](../README.md) / PowerDeadline

# Class: PowerDeadline

Deadline-aware async helper for timeout, retry budget, and abort metadata.

Use `PowerDeadline` to wrap async work with per-attempt timeouts, a total
deadline for the whole operation, and optional retry/backoff behavior.

 PowerDeadline

## Constructors

### Constructor

> **new PowerDeadline**(`options?`): `PowerDeadline`

Create a configured `PowerDeadline` instance.

#### Parameters

##### options?

`Object` = `{}`

Default options applied to every `run()` invocation.

#### Returns

`PowerDeadline`

## Properties

### \_options

> **\_options**: `Object`

## Methods

### run()

> **run**(`fn`, `options?`): `Promise`\<`any`\>

Run a function with the configured deadline options merged with per-call options.

#### Parameters

##### fn

`Function`

Async function to execute.

##### options?

[`PowerDeadlineOptions`](../../jsdoc-types/interfaces/PowerDeadlineOptions.md) = `{}`

#### Returns

`Promise`\<`any`\>

***

### run()

> `static` **run**(`fn`, `options?`): `Promise`\<`any`\>

Run a function with deadline semantics.

#### Parameters

##### fn

`Function`

Async function to execute.

##### options?

[`PowerDeadlineOptions`](../../jsdoc-types/interfaces/PowerDeadlineOptions.md) = `{}`

#### Returns

`Promise`\<`any`\>
