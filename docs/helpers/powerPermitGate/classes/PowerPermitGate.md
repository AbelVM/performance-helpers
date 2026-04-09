[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerPermitGate](../README.md) / PowerPermitGate

# Class: PowerPermitGate

PowerPermitGate

Internal helper that manages a finite number of permits and a FIFO waiter queue.
Provides `acquire()`, `tryAcquire()` and `release()` primitives used by
semaphore-like helpers.

 PowerPermitGate

## Extended by

- [`PowerBackpressure`](../../powerBackpressure/classes/PowerBackpressure.md)

## Constructors

### Constructor

> **new PowerPermitGate**(`options?`): `PowerPermitGate`

#### Parameters

##### options?

###### capacity?

`number`

###### initialTokens?

`number`

###### queueCapacity?

`number`

#### Returns

`PowerPermitGate`

## Properties

### \_available

> **\_available**: `number`

***

### \_capacity

> **\_capacity**: `number`

***

### \_queueCapacity

> **\_queueCapacity**: `number`

***

### \_waiters

> **\_waiters**: [`PowerQueue`](../../powerQueue/classes/PowerQueue.md)

## Accessors

### active

#### Get Signature

> **get** **active**(): `number`

Number of permits currently held.

##### Returns

`number`

***

### available

#### Get Signature

> **get** **available**(): `number`

Currently available permits.

##### Returns

`number`

***

### capacity

#### Get Signature

> **get** **capacity**(): `number`

Maximum number of permits.

##### Returns

`number`

***

### isFull

#### Get Signature

> **get** **isFull**(): `boolean`

True when the waiting queue is saturated.

##### Returns

`boolean`

***

### pending

#### Get Signature

> **get** **pending**(): `number`

Number of queued waiters.

##### Returns

`number`

***

### queueCapacity

#### Get Signature

> **get** **queueCapacity**(): `number`

Maximum number of waiters allowed in the queue.

##### Returns

`number`

## Methods

### \_grant()

> **\_grant**(): () => `void`

#### Returns

() => `void`

***

### \_makeRelease()

> **\_makeRelease**(): () => `void`

#### Returns

() => `void`

***

### acquire()

> **acquire**(): `Promise`\<`Function`\>

Acquire a permit asynchronously.
Resolves immediately when a permit is available; otherwise waits in FIFO order.

#### Returns

`Promise`\<`Function`\>

Promise resolving to a release callback.

***

### release()

> **release**(`count?`): `void`

Release one or more permits back to the gate.

#### Parameters

##### count?

`number` = `1`

#### Returns

`void`

***

### reset()

> **reset**(`options?`): `void`

Reset the gate and reject any waiting callers.

#### Parameters

##### options?

###### available?

`number`

Number of permits to restore after reset.

###### reason?

`Error`

Optional rejection reason for queued waiters.

#### Returns

`void`

***

### tryAcquire()

> **tryAcquire**(): `Function` \| `null`

Try to acquire a permit without waiting.

#### Returns

`Function` \| `null`

Release callback when acquired, otherwise `null`.
