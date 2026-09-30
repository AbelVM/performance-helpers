[**performance-helpers**](../../../README.md)

---

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

---

### \_status

> **\_status**: `"pending"` \| `"fulfilled"` \| `"rejected"`

---

### promise

> **promise**: `Promise`\<`any`\>

## Accessors

### fulfilled

#### Get Signature

> **get** **fulfilled**(): `boolean`

Convenience boolean: true if resolved successfully

##### Returns

`boolean`

---

### rejected

#### Get Signature

> **get** **rejected**(): `boolean`

Convenience boolean: true if rejected

##### Returns

`boolean`

---

### settled

#### Get Signature

> **get** **settled**(): `boolean`

Whether the deferred has been settled.

##### Returns

`boolean`

---

### status

#### Get Signature

> **get** **status**(): `"pending"` \| `"fulfilled"` \| `"rejected"`

Status of the deferred: 'pending' | 'fulfilled' | 'rejected'

##### Returns

`"pending"` \| `"fulfilled"` \| `"rejected"`

## Methods

### reject()

> **reject**(`err`): `void`

Reject the deferred promise. No-op if already settled.

#### Parameters

##### err

`any`

#### Returns

`void`

---

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
