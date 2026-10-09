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

`PowerLatchOptions` = `{}`

`onAbort` is invoked with the
  rejection reason by [PowerLatch#abort](#abort).

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

### \_disposed

> **\_disposed**: `boolean`

***

### \_nextWaiterToken

> **\_nextWaiterToken**: `number`

***

### \_onAbort

> **\_onAbort**: ((`reason`) => `void`) \| `null`

***

### \_waiters

> **\_waiters**: `Map`\<`number`, `PowerLatchWaiter`\>

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

> **get** **onAbort**(): ((`reason`) => `void`) \| `null`

Optional callback invoked when `abort()` is called: `(reason) => void`.

##### Returns

((`reason`) => `void`) \| `null`

#### Set Signature

> **set** **onAbort**(`fn`): `void`

##### Parameters

###### fn

((`reason`) => `void`) \| `null`

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

> **\_removeWaiter**(`waiterOrToken`): `PowerLatchWaiter` \| `null`

Detach a single waiter, either by token or by the waiter object itself.

The object form exists because `_settleAll` and `wait`'s timeout path
already hold the waiter; the token form is what the abort listener has.

#### Parameters

##### waiterOrToken

`number` \| `PowerLatchWaiter`

#### Returns

`PowerLatchWaiter` \| `null`

The removed waiter, or `null` if it was already gone.

***

### \_resolveAll()

> **\_resolveAll**(): `void`

#### Returns

`void`

***

### \_settleAll()

> **\_settleAll**(`settle`): `void`

Tear down every registered waiter, clearing its timer and abort listener,
then hand each `PowerDefer` to `settle`. Failures from either teardown are
swallowed so one bad waiter cannot strand the rest.

#### Parameters

##### settle

(`defer`) => `void`

#### Returns

`void`

***

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

Asynchronous disposal hook (thin wrapper). Forwards to sync disposal.

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [dispose](#dispose-1), so `using x = new X()` releases the instance
deterministically at scope exit.

#### Returns

`void`

***

### abort()

> **abort**(`reason?`): `void`

Abort pending waiters. If `reason` provided it will be used to reject waiters.

Idempotent. A second call is a no-op rather than a second abort: callers
abort on both an error path and a cleanup path, and one logical abort must
fire `onAbort` once.

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

### dispose()

> **dispose**(): `void`

Release every resource this instance holds. Terminal: pending waiters are
rejected with `code: 'EDISPOSED'`, the count is zeroed, later `wait()`
calls reject rather than registering, and `reset()` becomes a no-op.

This is a teardown, not a re-arm. It used to call `reset()` with its
default count of 1, which left every pending `wait()` unsettled forever and
left `remaining` at 1 — and because `reset()` clears the aborted state, it
also made an aborted latch live again. Compare
`PowerPermitGate.reset()`, which rejects its waiters.

Idempotent, and safe to call while the instance is idle. Exists so the
instance works with `using` / `await using` and gives callers an explicit
name to call.

#### Returns

`void`

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
If aborted via `abort()` pending waiters are rejected. A disposed latch
rejects too, with `code: 'EDISPOSED'` — see [PowerLatch#dispose](#dispose-1).

#### Parameters

##### opts?

`number` \| `PowerLatchWaitOptions`

#### Returns

`Promise`\<`void`\>

***

### one()

> `static` **one**(): `PowerLatch`

Create a latch that waits for a single signal.

#### Returns

`PowerLatch`
