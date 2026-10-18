[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerDefer](../README.md) / PowerDefer

# Class: PowerDefer

PowerDefer

Deferred promise utility exposing `promise`, `resolve` and `reject` helpers.
Useful when needing a promise whose resolution is controlled externally.

 PowerDefer

## Constructors

### Constructor

> **new PowerDefer**(): `PowerDefer`

#### Returns

`PowerDefer`

## Properties

### \_settled

> **\_settled**: `boolean`

***

### \_status

> **\_status**: `"pending"` \| `"fulfilled"` \| `"rejected"` \| `"cancelled"`

***

### promise

> **promise**: `Promise`\<`any`\>

## Accessors

### cancelled

#### Get Signature

> **get** **cancelled**(): `boolean`

Convenience boolean: true if cancelled.

##### Returns

`boolean`

***

### fulfilled

#### Get Signature

> **get** **fulfilled**(): `boolean`

Convenience boolean: true if resolved successfully

##### Returns

`boolean`

***

### rejected

#### Get Signature

> **get** **rejected**(): `boolean`

Convenience boolean: true if rejected

##### Returns

`boolean`

***

### settled

#### Get Signature

> **get** **settled**(): `boolean`

Whether the deferred has been settled.

##### Returns

`boolean`

***

### status

#### Get Signature

> **get** **status**(): `"pending"` \| `"fulfilled"` \| `"rejected"`

Status of the deferred: 'pending' | 'fulfilled' | 'rejected'

##### Returns

`"pending"` \| `"fulfilled"` \| `"rejected"`

## Methods

### cancel()

> **cancel**(`reason?`): `void`

Cancel the deferred promise. Rejects it with an `AbortError` (or the
supplied reason) and marks it cancelled. No-op if already settled.

Useful for tearing down a barrier that is no longer needed: callers
awaiting `defer.promise` receive the rejection instead of hanging.

#### Parameters

##### reason?

`any`

Rejection reason. Defaults to an `AbortError`.

#### Returns

`void`

***

### reject()

> **reject**(`err`): `void`

Reject the deferred promise. No-op if already settled.

#### Parameters

##### err

`any`

#### Returns

`void`

***

### resolve()

> **resolve**(`value?`): `void`

Resolve the deferred promise. No-op if already settled.

`value` is optional because the common case is a signal rather than a
payload: `PowerLatch` resolves each waiter's deferred with no argument to
fulfil a `Promise<void>`, and requiring `resolve(undefined)` at every such
call site would be noise.

#### Parameters

##### value?

`any`

#### Returns

`void`
