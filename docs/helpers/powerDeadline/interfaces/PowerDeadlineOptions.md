[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerDeadline](../README.md) / PowerDeadlineOptions

# Interface: PowerDeadlineOptions

## Properties

### attemptTimeout?

> `optional` **attemptTimeout?**: `number`

Timeout in milliseconds for each attempt.

***

### maxAttempts?

> `optional` **maxAttempts?**: `number`

Maximum attempts (including the initial try).

***

### onRetry?

> `optional` **onRetry?**: (`attempt`, `err`, `delay`) => `void`

Callback invoked before a retry delay.

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

### retryDelay?

> `optional` **retryDelay?**: `number`

Delay in milliseconds before retrying.

***

### retryIf?

> `optional` **retryIf?**: (`err`) => `boolean`

Predicate to determine whether to retry after an error.

#### Parameters

##### err

`any`

#### Returns

`boolean`

***

### signal?

> `optional` **signal?**: `AbortSignal`

Optional abort signal to cancel the operation.

***

### totalTimeout?

> `optional` **totalTimeout?**: `number`

Total deadline in milliseconds for the entire run.
