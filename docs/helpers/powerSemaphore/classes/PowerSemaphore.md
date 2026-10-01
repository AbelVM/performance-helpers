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

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [dispose](#dispose-1), so `using x = new X()` releases the instance
deterministically at scope exit.

#### Returns

`void`

***

### acquire()

> **acquire**(`options?`): `Promise`\<() => `void`\>

Acquire a permit asynchronously.
Resolves immediately when one is available; otherwise waits in FIFO order.

#### Parameters

##### options?

Pass `options.signal` to stop
  waiting: the returned promise rejects with an `AbortError` and the caller
  leaves the queue instead of holding a slot until a permit arrives.

###### signal?

`AbortSignal`

#### Returns

`Promise`\<() => `void`\>

Promise resolving to the release
  callback. Spelled as a call signature rather than `Function` because
  `Function` is not assignable to `() => void`, so `.then((release) =>
  release())` - the documented way to use it - failed to type-check for
  consumers.

***

### dispose()

> **dispose**(): `void`

Release every resource this instance holds.

Idempotent, and safe to call while the instance is idle. Exists so the
instance works with `using` / `await using` and gives callers an explicit
name to call.

#### Returns

`void`

***

### reset()

> **reset**(): `void`

Reset the semaphore and reject any queued waiters.

#### Returns

`void`

***

### run()

> **run**\<`T`\>(`fn`, `options?`): `Promise`\<`T`\>

Execute a callback while holding a permit.
The permit is released after the callback resolves or rejects.

`options` is forwarded to [acquire](#acquire), so `{ signal }` cancels the
*wait* for a permit. It used to be accepted and thrown away — this method
took only `fn` — so a caller who mirrored `acquire()` got a promise that
could not be cancelled and, with an already-aborted signal, hung until a
permit happened to be released. `run` is the form people reach for first,
so cancellation matters more here than on `acquire`.

#### Type Parameters

##### T

`T`

#### Parameters

##### fn

() => `T` \| `Promise`\<`T`\>

Callback to run under a permit.

##### options?

Forwarded to [acquire](#acquire).

###### signal?

`AbortSignal`

#### Returns

`Promise`\<`T`\>

The callback result.

***

### tryAcquire()

> **tryAcquire**(): `PowerReleaseFn` \| `null`

Try to acquire a permit without waiting.

#### Returns

`PowerReleaseFn` \| `null`

Release callback when acquired, otherwise `null`.
