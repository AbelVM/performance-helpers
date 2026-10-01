[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerBackpressure](../README.md) / PowerBackpressure

# Class: PowerBackpressure

## Extends

- [`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md)

## Constructors

### Constructor

> **new PowerBackpressure**(`options?`): `PowerBackpressure`

#### Parameters

##### options?

`PowerBackpressureOptions` = `{}`

`capacity` and `queueCapacity`
  are inherited from `PowerPermitGate`; the rest tune the refill schedule.

#### Returns

`PowerBackpressure`

#### Overrides

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`constructor`](../../powerPermitGate/classes/PowerPermitGate.md#constructor)

## Properties

### \_adaptive

> **\_adaptive**: `object`

#### additiveIncrease

> **additiveIncrease**: `number`

#### beta

> **beta**: `number`

#### enabled

> **enabled**: `boolean`

#### max

> **max**: `number`

#### min

> **min**: `number`

***

### \_adaptiveHeartbeat

> **\_adaptiveHeartbeat**: `boolean`

***

### \_available

> **\_available**: `number`

#### Inherited from

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`_available`](../../powerPermitGate/classes/PowerPermitGate.md#_available)

***

### \_baseRefillAmount

> **\_baseRefillAmount**: `number`

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

Number of permits currently held by callers that have not released yet.

Read from `_held` rather than computed as `capacity - available`. The two are
the same number whenever `capacity` is a ceiling on concurrent holders -
which it is for this class, for `PowerSemaphore` and for `PowerBulkhead`, and
there the difference is invisible. It stops being the same for a subclass
whose refill can mint more permits than the pool size while a queue waits,
and there the difference is the whole point: `capacity - available` cannot
exceed `capacity`, so on a `PowerBackpressure` with a consumer that is not
returning its permits it saturates at `capacity` and reports a healthy gate
while the work is piling up. `_held` keeps counting. See ADR 0004.

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

***

### refillAmount

#### Get Signature

> **get** **refillAmount**(): `number`

The refill amount the controller is currently probing with.

With `adaptive` enabled this moves: up by `additiveIncrease` on every
refill that finds consumers draining, and down by a factor of `beta` on
every refill that finds them not. With it disabled it is constant, and
equal to the `refillAmount` option.

##### Returns

`number`

## Methods

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

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [dispose](#dispose-1), so `using x = new X()` releases the instance
deterministically at scope exit.

#### Returns

`void`

#### Overrides

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`[dispose]`](../../powerPermitGate/classes/PowerPermitGate.md#dispose)

***

### acquire()

> **acquire**(`options?`): `Promise`\<`PowerReleaseFn`\>

Acquire a permit asynchronously.
Resolves immediately when a permit is available.
Otherwise queues the producer until capacity frees.

#### Parameters

##### options?

`Object` = `{}`

`signal` aborts the wait: the returned promise
  rejects with an `AbortError` and the producer leaves the queue instead of
  holding a slot until a permit is refilled.

#### Returns

`Promise`\<`PowerReleaseFn`\>

Promise resolving to a release callback.

#### Overrides

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`acquire`](../../powerPermitGate/classes/PowerPermitGate.md#acquire)

***

### dispose()

> **dispose**(): `void`

Release every resource this instance holds.

Idempotent, and safe to call while the instance is idle. Exists so the
instance works with `using` / `await using` and gives callers an explicit
name to call.

#### Returns

`void`

#### Overrides

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`dispose`](../../powerPermitGate/classes/PowerPermitGate.md#dispose-1)

***

### release()

> **release**(`count?`): `number`

Release one or more permits back to the controller.

#### Parameters

##### count?

`number` = `1`

#### Returns

`number`

Permits returned to the gate rather than transferred.

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

> **tryAcquire**(): `PowerReleaseFn` \| `null`

Try to acquire a permit immediately.

#### Returns

`PowerReleaseFn` \| `null`

Release callback, or `null` if no permit is available.

#### Overrides

[`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md).[`tryAcquire`](../../powerPermitGate/classes/PowerPermitGate.md#tryacquire)
