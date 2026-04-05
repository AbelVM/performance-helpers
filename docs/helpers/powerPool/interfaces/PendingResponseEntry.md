[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerPool](../README.md) / PendingResponseEntry

# Interface: PendingResponseEntry

## Properties

### reject

> **reject**: (`arg0`) => `void`

Function to reject the pending Promise with an error.

#### Parameters

##### arg0

`any`

#### Returns

`void`

***

### resolve

> **resolve**: (`arg0`) => `void`

Function to resolve the pending Promise with the worker response.

#### Parameters

##### arg0

`any`

#### Returns

`void`

***

### timer?

> `optional` **timer?**: `any`

Optional timeout handle used to cancel the pending request.
