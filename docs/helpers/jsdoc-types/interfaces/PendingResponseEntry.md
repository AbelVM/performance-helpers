[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/jsdoc-types](../README.md) / PendingResponseEntry

# Interface: PendingResponseEntry

## Properties

### reject

> **reject**: (`arg0`) => `void`

Reject function for the pending Promise.

#### Parameters

##### arg0

`any`

#### Returns

`void`

***

### resolve

> **resolve**: (`arg0`) => `void`

Resolve function for the pending Promise.

#### Parameters

##### arg0

`any`

#### Returns

`void`

***

### timer?

> `optional` **timer?**: `any`

Optional timeout handle used to cancel the pending request.
