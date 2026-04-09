[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerBackpressure](../README.md) / PowerBackpressure

# Class: PowerBackpressure

PowerBackpressure

Producer-facing backpressure controller built on top of `PowerPermitGate`.
Provides adaptive refill behavior and FIFO queuing for producers.

 PowerBackpressure

## Extends

- [`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md)

## Constructors

### Constructor

> **new PowerBackpressure**(`options?`): `PowerBackpressure`

#### Parameters

##### options?

###### capacity?

`number`

Maximum number of concurrent permits.

###### initialTokens?

`number`

Initial available permits.

###### lowWaterMark?

`number`

When available tokens drop below this threshold, adaptive refill begins.

###### queueCapacity?

`number`

Maximum number of waiting producers.

###### refillAmount?

`number`

Base refill amount when pressure is detected.

###### refillInterval?

`number`

Refill interval in milliseconds.

#### Returns

`PowerBackpressure`

#### Overrides

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`constructor`](../../powerPermitGate/classes/PowerPermitGate.md#constructor)

## Properties

### \_available

> **\_available**: `number`

#### Inherited from

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`_available`](../../powerPermitGate/classes/PowerPermitGate.md#_available)

***

### \_capacity

> **\_capacity**: `number`

#### Inherited from

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`_capacity`](../../powerPermitGate/classes/PowerPermitGate.md#_capacity)

***

### \_lowWaterMark

> **\_lowWaterMark**: `number`

***

### \_queueCapacity

> **\_queueCapacity**: `number`

#### Inherited from

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`_queueCapacity`](../../powerPermitGate/classes/PowerPermitGate.md#_queuecapacity)

***

### \_refillAmount

> **\_refillAmount**: `number`

***

### \_refillInterval

> **\_refillInterval**: `number`

***

### \_refillTimer

> **\_refillTimer**: `any`

***

### \_waiters

> **\_waiters**: [`PowerQueue`](../../powerQueue/classes/PowerQueue.md)

#### Inherited from

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`_waiters`](../../powerPermitGate/classes/PowerPermitGate.md#_waiters)

## Accessors

### active

#### Get Signature

> **get** **active**(): `number`

Number of permits currently held.

##### Returns

`number`

#### Inherited from

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`active`](../../powerPermitGate/classes/PowerPermitGate.md#active)

***

### available

#### Get Signature

> **get** **available**(): `number`

Available permits for producers.

##### Returns

`number`

#### Overrides

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`available`](../../powerPermitGate/classes/PowerPermitGate.md#available)

***

### capacity

#### Get Signature

> **get** **capacity**(): `number`

Maximum concurrent permits.

##### Returns

`number`

#### Overrides

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`capacity`](../../powerPermitGate/classes/PowerPermitGate.md#capacity)

***

### isFull

#### Get Signature

> **get** **isFull**(): `boolean`

True when the waiting queue is full.

##### Returns

`boolean`

#### Overrides

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`isFull`](../../powerPermitGate/classes/PowerPermitGate.md#isfull)

***

### pending

#### Get Signature

> **get** **pending**(): `number`

Number of producers currently waiting for permits.

##### Returns

`number`

#### Overrides

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`pending`](../../powerPermitGate/classes/PowerPermitGate.md#pending)

***

### queueCapacity

#### Get Signature

> **get** **queueCapacity**(): `number`

Maximum number of waiting producers.

##### Returns

`number`

#### Overrides

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`queueCapacity`](../../powerPermitGate/classes/PowerPermitGate.md#queuecapacity)

## Methods

### \_grant()

> **\_grant**(): () => `void`

#### Returns

() => `void`

#### Overrides

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`_grant`](../../powerPermitGate/classes/PowerPermitGate.md#_grant)

***

### \_makeRelease()

> **\_makeRelease**(): () => `void`

#### Returns

() => `void`

#### Inherited from

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`_makeRelease`](../../powerPermitGate/classes/PowerPermitGate.md#_makerelease)

***

### \_performRefill()

> **\_performRefill**(): `void`

#### Returns

`void`

***

### \_scheduleRefill()

> **\_scheduleRefill**(): `void`

#### Returns

`void`

***

### acquire()

> **acquire**(): `Promise`\<`Function`\>

Acquire a permit asynchronously.
Resolves immediately when a permit is available.
Otherwise queues the producer until capacity frees.

#### Returns

`Promise`\<`Function`\>

Promise resolving to a release callback.

#### Overrides

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`acquire`](../../powerPermitGate/classes/PowerPermitGate.md#acquire)

***

### release()

> **release**(`count?`): `void`

Release one or more permits back to the controller.

#### Parameters

##### count?

`number` = `1`

#### Returns

`void`

#### Overrides

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`release`](../../powerPermitGate/classes/PowerPermitGate.md#release)

***

### reset()

> **reset**(): `void`

Reset the controller to its initial capacity and clear waiting producers.

#### Returns

`void`

#### Overrides

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`reset`](../../powerPermitGate/classes/PowerPermitGate.md#reset)

***

### tryAcquire()

> **tryAcquire**(): `Function` \| `null`

Try to acquire a permit immediately.

#### Returns

`Function` \| `null`

Release callback, or `null` if no permit is available.

#### Overrides

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`tryAcquire`](../../powerPermitGate/classes/PowerPermitGate.md#tryacquire)
