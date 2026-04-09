[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerLatch](../README.md) / PowerLatch

# Class: PowerLatch

## Constructors

### Constructor

> **new PowerLatch**(`count?`, `options?`): `PowerLatch`

#### Parameters

##### count?

`number` = `1`

initial count required to release the latch

##### options?

#### Returns

`PowerLatch`

## Properties

### \_aborted

> **\_aborted**: `boolean`

***

### \_abortReason

> **\_abortReason**: `any`

***

### \_count

> **\_count**: `number`

***

### \_nextWaiterToken

> **\_nextWaiterToken**: `number`

***

### \_onAbort

> **\_onAbort**: `any`

***

### \_waiters

> **\_waiters**: `Map`\<`number`, \{ `defer`: [`PowerDefer`](../../powerDefer/classes/PowerDefer.md); `signal?`: `AbortSignal`; `signalHandler?`: `Function`; `timer?`: `any`; `token`: `number`; \}\>

## Accessors

### done

#### Get Signature

> **get** **done**(): `boolean`

True when the latch is already released.

##### Returns

`boolean`

***

### onAbort

#### Get Signature

> **get** **onAbort**(): `any`

Optional callback invoked when `abort()` is called: `(reason) => void`.

##### Returns

`any`

#### Set Signature

> **set** **onAbort**(`fn`): `void`

##### Parameters

###### fn

`any`

##### Returns

`void`

***

### remaining

#### Get Signature

> **get** **remaining**(): `number`

Number of remaining counts.

##### Returns

`number`

## Methods

### \_rejectAll()

> **\_rejectAll**(`err`): `void`

#### Parameters

##### err

`any`

#### Returns

`void`

***

### \_removeWaiter()

> **\_removeWaiter**(`waiterOrToken`): \{ `defer`: [`PowerDefer`](../../powerDefer/classes/PowerDefer.md); `signal?`: `AbortSignal`; `signalHandler?`: `Function`; `timer?`: `any`; `token`: `number`; \} \| `null`

#### Parameters

##### waiterOrToken

`any`

#### Returns

\{ `defer`: [`PowerDefer`](../../powerDefer/classes/PowerDefer.md); `signal?`: `AbortSignal`; `signalHandler?`: `Function`; `timer?`: `any`; `token`: `number`; \} \| `null`

***

### \_resolveAll()

> **\_resolveAll**(): `void`

#### Returns

`void`

***

### abort()

> **abort**(`reason?`): `void`

Abort pending waiters. If `reason` provided it will be used to reject waiters.

#### Parameters

##### reason?

`any`

#### Returns

`void`

***

### countDown()

> **countDown**(`n?`): `number`

Decrement the latch by one (or by `n` if provided). When the count
reaches zero all pending waiters are resolved.

#### Parameters

##### n?

`number` = `1`

#### Returns

`number`

remaining count

***

### decrementUnlessZero()

> **decrementUnlessZero**(): `number`

Decrement the latch only if it's greater than zero.
Returns remaining count.

#### Returns

`number`

***

### reset()

> **reset**(`count?`): `void`

Reset the latch to a new count. Any existing waiters will be resolved
immediately if the new count is zero.

#### Parameters

##### count?

`number` = `1`

#### Returns

`void`

***

### wait()

> **wait**(`opts?`): `Promise`\<`void`\>

Wait until the latch reaches zero.
Options: `wait(timeoutMs)` or `wait({ timeout, signal })`.
If aborted via `abort()` pending waiters are rejected.

#### Parameters

##### opts?

`number` \| `object`

#### Returns

`Promise`\<`void`\>

***

### one()

> `static` **one**(): `PowerLatch`

Create a latch that waits for a single signal.

#### Returns

`PowerLatch`
