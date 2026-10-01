[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerSemaphore](../README.md) / PowerSemaphore

# Class: PowerSemaphore

## Constructors

### Constructor

> **new PowerSemaphore**(`limit?`, `queueCapacity?`): `PowerSemaphore`

Create a semaphore.

#### Parameters

##### limit?

`number` = `1`

Maximum number of concurrent permits.

##### queueCapacity?

`undefined` = `undefined`

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

### isFull

#### Get Signature

> **get** **isFull**(): `boolean`

True when the waiting queue is saturated.

Counted against live waiters only, so a burst of cancellations does not read
as a full queue.

##### Returns

`boolean`

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

***

### queueCapacity

#### Get Signature

> **get** **queueCapacity**(): `number`

Maximum number of waiters allowed in the queue, or `Infinity` when unbounded.

Proxied from the gate rather than kept private. `PowerSemaphore` used to
build a gate that could queue without limit and expose neither the bound nor
whether it had been reached, so a caller using this class — the one most
people reach for — could neither cap the queue nor observe it filling. Both
halves of the primitive were unreachable through the wrapper.

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
