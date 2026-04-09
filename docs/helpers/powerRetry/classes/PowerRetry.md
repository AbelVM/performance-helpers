[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerRetry](../README.md) / PowerRetry

# Class: PowerRetry

Retry helper with configurable backoff and jitter.

 PowerRetry

## Example

```ts
const retry = new PowerRetry({ maxAttempts: 4, baseDelay: 50 });
const data = await retry.run(() => fetch('/api/data'));
```

## Constructors

### Constructor

> **new PowerRetry**(`options?`): `PowerRetry`

Run a function with retry/backoff semantics.
Create a configured retry helper.

#### Parameters

##### options?

[`PowerRetryOptions`](../interfaces/PowerRetryOptions.md) = `{}`

Default options applied to every `run()` invocation.

#### Returns

`PowerRetry`

## Properties

### \_options

> **\_options**: [`PowerRetryOptions`](../interfaces/PowerRetryOptions.md)

## Methods

### run()

> **run**(`fn`, `options?`): `Promise`\<`any`\>

Instance method that runs `fn` with the configured options merged with
any per-call `options` provided.

#### Parameters

##### fn

`Function`

Async function to execute.

##### options?

[`PowerRetryOptions`](../interfaces/PowerRetryOptions.md) = `{}`

Per-call retry overrides.

#### Returns

`Promise`\<`any`\>

Resolves with `fn` result, rejects with final attempt error.

***

### run()

> `static` **run**(`fn`, `options?`): `Promise`\<`any`\>

Execute a function with retry/backoff semantics.

#### Parameters

##### fn

`Function`

Async function to execute.

##### options?

[`PowerRetryOptions`](../interfaces/PowerRetryOptions.md) = `{}`

Retry behavior overrides for this invocation.

#### Returns

`Promise`\<`any`\>

Resolves with `fn` result, rejects with final attempt error.

#### Throws

When `fn` is not callable or `maxAttempts` is not a positive finite number.
