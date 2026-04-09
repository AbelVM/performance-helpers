[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerRetry](../README.md) / PowerRetryOptions

# Interface: PowerRetryOptions

## Properties

### attemptTimeout?

> `optional` **attemptTimeout?**: `number`

Per-attempt timeout in milliseconds.

***

### backoff?

> `optional` **backoff?**: `"exponential"` \| `"linear"` \| `"fixed"`

Delay strategy between attempts.

***

### baseDelay?

> `optional` **baseDelay?**: `number`

Base delay in milliseconds.

***

### jitter?

> `optional` **jitter?**: `boolean`

Adds jitter to delay calculations.

***

### maxAttempts?

> `optional` **maxAttempts?**: `number`

Maximum attempts (initial try + retries). Must be a positive finite number.

***

### maxDelay?

> `optional` **maxDelay?**: `number`

Maximum delay in milliseconds.

***

### onRetry?

> `optional` **onRetry?**: (`attempt`, `err`, `delay`) => `void`

#### Parameters

##### attempt

`number`

##### err

`any`

##### delay

`number`

#### Returns

`void`

***

### retryIf?

> `optional` **retryIf?**: (`err`) => `boolean`

#### Parameters

##### err

`any`

#### Returns

`boolean`
