[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerSemaphore](../README.md) / PowerSemaphore

# Class: PowerSemaphore

## Constructors

### Constructor

> **new PowerSemaphore**(`limit?`): `PowerSemaphore`

Create a semaphore.

#### Parameters

##### limit?

`number` = `1`

Maximum number of concurrent permits.

#### Returns

`PowerSemaphore`

## Properties

### \_gate

> **\_gate**: [`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md)

## Accessors

### active

#### Get Signature

> **get** **active**(): `number`

Currently acquired permits.

##### Returns

`number`

***

### available

#### Get Signature

> **get** **available**(): `number`

Number of permits still available.

##### Returns

`number`

***

### isLocked

#### Get Signature

> **get** **isLocked**(): `boolean`

True when the semaphore is fully acquired.

##### Returns

`boolean`

***

### limit

#### Get Signature

> **get** **limit**(): `number`

Maximum concurrent holders.

##### Returns

`number`

***

### pending

#### Get Signature

> **get** **pending**(): `number`

Number of callers waiting for a permit.

##### Returns

`number`

## Methods

### acquire()

> **acquire**(): `Promise`\<`Function`\>

Acquire a permit asynchronously.
Resolves immediately when one is available; otherwise waits in FIFO order.

#### Returns

`Promise`\<`Function`\>

Promise resolving to the release callback.

***

### reset()

> **reset**(): `void`

Reset the semaphore and reject any queued waiters.

#### Returns

`void`

***

### run()

> **run**\<`T`\>(`fn`): `Promise`\<`T`\>

Execute a callback while holding a permit.
The permit is released after the callback resolves or rejects.

#### Type Parameters

##### T

`T`

#### Parameters

##### fn

() => `T` \| `Promise`\<`T`\>

Callback to run under a permit.

#### Returns

`Promise`\<`T`\>

The callback result.

***

### tryAcquire()

> **tryAcquire**(): `Function` \| `null`

Try to acquire a permit without waiting.

#### Returns

`Function` \| `null`

Release callback when acquired, otherwise `null`.
