[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/jsdoc-types](../README.md) / PowerDeadlineOptions

# Interface: PowerDeadlineOptions

## Properties

### attemptTimeout?

> `optional` **attemptTimeout?**: `number`

***

### backoff?

> `optional` **backoff?**: `"exponential"` \| `"linear"` \| `"fixed"`

***

### baseDelay?

> `optional` **baseDelay?**: `number`

***

### jitter?

> `optional` **jitter?**: `boolean`

***

### maxAttempts?

> `optional` **maxAttempts?**: `number`

***

### maxDelay?

> `optional` **maxDelay?**: `number`

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

### retryDelay?

> `optional` **retryDelay?**: `number`

***

### retryIf?

> `optional` **retryIf?**: (`err`) => `boolean`

#### Parameters

##### err

`any`

#### Returns

`boolean`

***

### signal?

> `optional` **signal?**: `AbortSignal`

***

### totalTimeout?

> `optional` **totalTimeout?**: `number`
