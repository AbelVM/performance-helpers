[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerPermitGate](../README.md) / PowerPermitGate

# Class: PowerPermitGate

## Extended by

- [`PowerBackpressure`](../../powerBackpressure/classes/PowerBackpressure.md)

## Constructors

### Constructor

> **new PowerPermitGate**(`options?`): `PowerPermitGate`

#### Parameters

##### options?

`PowerPermitGateOptions` = `{}`

`className` and `limitName` let a
  wrapping class report its own vocabulary in validation messages; see
  PowerPermitGateOptions.

#### Returns

`PowerPermitGate`

## Properties

### \_available

> **\_available**: `number`

***

### \_capacity

> **\_capacity**: `number`

***

### \_held

> `protected` **\_held**: `number`

Permits that have been granted and not yet returned.

The single count of outstanding work in this class, and the reason
[PowerPermitGate#reset](#reset) can no longer mint a permit. The invariant
it maintains is `_available + _held === _capacity`; `reset()` may only set
`_available` up to `capacity - _held`, so a holder that is still running
keeps occupying its permit across a reset instead of the reset handing
out a second one. Both grant paths go through `_grantTo`, so there is no
way for a permit to exist without being counted here.

`protected` rather than `private`: `PowerBackpressure` reads it for its
heartbeat termination condition and for its `_inFlight` view, and
`_serveWaiters` below is driven the same way. Neither is part of the
public surface - `protected` keeps them out of what a consumer calls - but
a subclass reading a base field is precisely what the tag describes.

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

Number of queued waiters, excluding any that have been aborted.

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

### \_makeRelease()

> **\_makeRelease**(): () => `void`

#### Returns

() => `void`

***

### \_serveWaiters()

> `protected` **\_serveWaiters**(`permits`, `fromAvailable`): `number`

Hand permits to queued waiters, skipping any that have been aborted.

Shared by `release()` and the `PowerBackpressure` refill loop, which is the
point: the refill loop used to shift entries itself, so it neither skipped
cancelled ones nor decremented `_cancelledWaiters`. A single cancellation
therefore left the counter permanently one too high, `pending` reported 0
with a live waiter still queued, and every refill tick short-circuited on
`pending === 0` - a self-sustaining deadlock that only `reset()` cleared.

Aborted entries are compacted here rather than on the abort path, on
purpose: removing by reference from a ring buffer is O(n) per cancellation,
and a cancellation storm is exactly when an O(n) walk per cancelled waiter
is least affordable. The `_cancelledWaiters` counter keeps
[PowerPermitGate#pending](#pending) and [PowerPermitGate#isFull](#isfull) honest in
the meantime.

#### Parameters

##### permits

`number`

Maximum number of waiters to serve.

##### fromAvailable

`boolean`

Whether the served permits are drawn from
  `_available` (they were counted into the pool first) or transferred
  straight from a holder without ever entering it. See
  PowerPermitGate#\_grantTo; the two routes differ only in that
  flag, and conflating them is what put `_available` below zero.

#### Returns

`number`

How many were served.

***

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [dispose](#dispose-1), so `using x = new X()` releases the instance
deterministically at scope exit.

#### Returns

`void`

***

### acquire()

> **acquire**(`options?`): `Promise`\<`PowerReleaseFn`\>

Acquire a permit asynchronously.
Resolves immediately when a permit is available; otherwise waits in FIFO order.

#### Parameters

##### options?

`signal` aborts the *wait* for a
  permit, not any work started once one is held — see `src/utils/abort.js`.
  Checked before the fast path, so an already-aborted signal rejects rather
  than resolving because a permit happened to be free.

###### signal?

`AbortSignal`

#### Returns

`Promise`\<`PowerReleaseFn`\>

Promise resolving to a release callback.

***

### dispose()

> **dispose**(): `void`

Release every resource this instance holds: queued waiters are rejected and
the listener registry is emptied.

Idempotent, and safe to call while the instance is idle. Exists so the
instance works with `using` / `await using`.

#### Returns

`void`

***

### release()

> **release**(`count?`): `number`

Release one or more permits back to the gate.

Released permits are handed straight to queued waiters where possible, so
a release that serves a waiter is a *transfer*: the permit is never
available in between, and the waiter is a holder from that instant. The
return value is the number of permits that actually came back to the gate
rather than being transferred, which is what a caller tracking outstanding
work needs - decrementing it by the requested count would subtract permits
that are still out.

#### Parameters

##### count?

`number` = `1`

#### Returns

`number`

Permits returned to the gate rather than transferred.

***

### reset()

> **reset**(`options?`): `void`

Reset the gate and reject any waiting callers.

Outstanding holders are *not* settled: the promise that produced a release
callback has already resolved, so there is nothing left to reject. What a
reset can do is stop pretending those permits are free - `_available` is
capped at `capacity - _held`, so a holder that is still running keeps
occupying its permit and a second `acquire()` cannot be granted alongside
it. When the holder does release, the permit returns normally. The previous
behaviour set `_available` unconditionally, so `reset()` on a gate of 1
with one holder running produced a *second* concurrent holder against a
limit of 1, permanently, and the first holder's release was then absorbed
by the capacity clamp.

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

> **tryAcquire**(): `PowerReleaseFn` \| `null`

Try to acquire a permit without waiting.

#### Returns

`PowerReleaseFn` \| `null`

Release callback when acquired, otherwise `null`.
