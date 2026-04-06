[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerObserver](../README.md) / PowerObserver

# Class: PowerObserver

## Constructors

### Constructor

> **new PowerObserver**(`initial`, `options?`): `PowerObserver`

Create a new PowerObserver.

#### Parameters

##### initial

`any`

Initial value

##### options?

[`PowerObserverOptions`](../interfaces/PowerObserverOptions.md) = `{}`

#### Returns

`PowerObserver`

## Properties

### \_distinct

> **\_distinct**: `boolean`

***

### \_map

> **\_map**: `Function` \| `null`

***

### \_pending

> **\_pending**: `boolean`

***

### \_pendingNext

> **\_pendingNext**: `any`

***

### \_pendingPrev

> **\_pendingPrev**: `any`

***

### \_scheduleMode

> **\_scheduleMode**: `string`

***

### \_scheduler

> **\_scheduler**: [`PowerScheduler`](../../powerScheduler/classes/PowerScheduler.md)

***

### \_subs

> **\_subs**: [`PowerSubscriberSet`](../../powerSubscriberSet/classes/PowerSubscriberSet.md)

***

### \_value

> **\_value**: `any`

## Accessors

### size

#### Get Signature

> **get** **size**(): `number`

Number of subscribers

##### Returns

`number`

***

### value

#### Get Signature

> **get** **value**(): `any`

Current value

##### Returns

`any`

#### Set Signature

> **set** **value**(`v`): `void`

Set value and schedule notification according to `async` option

##### Parameters

###### v

`any`

##### Returns

`void`

## Methods

### \_flushPending()

> **\_flushPending**(): `void`

Internal flush implementation

#### Returns

`void`

***

### clear()

> **clear**(): `void`

Remove all subscribers

#### Returns

`void`

***

### drain()

> **drain**(): `void`

Alias for flush()

#### Returns

`void`

***

### flush()

> **flush**(): `void`

Flush any pending notification immediately. Useful for tests or shutdown.

#### Returns

`void`

***

### map()

> **map**(`fn`): `void`

Set or replace the mapping function used for notifications

#### Parameters

##### fn

`any`

#### Returns

`void`

***

### subscribe()

> **subscribe**(`fn`): () => `boolean`

Subscribe to changes. Returns an unsubscribe function.

#### Parameters

##### fn

(`next`, `prev`) => `void`

#### Returns

() => `boolean`
