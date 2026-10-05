[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerCrossLock](../README.md) / PowerCrossLock

# Class: PowerCrossLock

## Constructors

### Constructor

> **new PowerCrossLock**(`options?`): `PowerCrossLock`

#### Parameters

##### options?

`PowerCrossLockOptions` = `{}`

Configuration.

#### Returns

`PowerCrossLock`

## Properties

### \_aborted

> **\_aborted**: `number`

***

### \_acquisitions

> **\_acquisitions**: `number`

***

### \_name

> **\_name**: `string`

***

### \_steals

> **\_steals**: `number`

## Accessors

### supported

#### Get Signature

> **get** **supported**(): `boolean`

Whether this platform can honour a cross-worker lock.

##### Returns

`boolean`

## Methods

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [dispose](#dispose-1), so `using lock = new PowerCrossLock()` releases it at
scope exit.

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

Release this instance. There is nothing to release — no timer, no listener, no queue
of this library's own — so this is a **state reset**, not a teardown, and the lock
manager's own locks are deliberately left alone: another instance may be mid-section.

Idempotent, and safe while idle, so the instance works with `using`.

#### Returns

`void`

***

### query()

> **query**(`name?`): `Promise`\<\{ `held`: `object`[]; `pending`: `object`[]; \}\>

Who holds `name`, and who is queued for it — **from this thread's point of view**.

## `query()` is per-thread, and that is not a documentation quirk

The plan row implied this method saw cross-worker state, and **it does not.** Measured
on Node 24.18 with a lock held in a `Worker`: the main thread's `query()` reported
`held: []`, and the worker's own `query()` reported the lock. So `query()` answers
"what is *my* thread doing here", not "who has this lock in the process".

That is a real limitation and it is the reason this method is documented rather than
promoted: it is still useful — it is the only way to see whether *you* are blocked and
on what name — but a caller who wants to know whether **another** worker is holding a
lock has to look at their own code, because the platform does not expose that. The
cross-worker guarantee rests on `request()` alone, which is atomic and shared.

#### Parameters

##### name?

`string`

One lock, or every lock when omitted.

#### Returns

`Promise`\<\{ `held`: `object`[]; `pending`: `object`[]; \}\>

***

### run()

> **run**(`name`, `fn`, `options?`): `Promise`\<`any`\>

Run `fn` while holding `name`, releasing it however `fn` ends.

**Callback-scoped rather than a `release()` function, and that is the API decision.**
The plan row asked for `acquire(name, {steal, signal})` returning a handle. A manual
release is the wrong shape for a lock shared across worker boundaries: a caller that
forgets it wedges *every other worker* for the life of the process, with no error and
no local state to inspect. Scoping the lock to the callback makes the release
unconditional — a throw, a rejection, and a `return` all release it, because the
platform is holding the lock across the callback's promise rather than across a line
of the caller's code.

## `steal` is not a polite hand-over

**Measured on Node 24.18.** With one holder inside `request()` and a second
`request(name, {steal: true})`:

- the second callback runs;
- the **first holder's `request()` promise rejects** with
  `DOMException [AbortError]` (`code: 20`);
- the first holder's callback **does not stop** — its work runs to completion while
  the lock is free to everyone else.

So `steal` means *release now and tell the old owner it lost*. Two things a caller
has to design around: the stolen holder **cannot tell a steal from its own signal**
(the `AbortError` carries no lock name and no own properties — checked), and the code
the previous owner was inside keeps running against whatever invariant the lock was
protecting. Hence opt-in per call rather than an instance default, and hence the
guide's advice to make the critical section idempotent before using it.

#### Parameters

##### name

`string`

Lock name. Shared by every caller that must exclude the others.

##### fn

() => `any`

The critical section.

##### options?

`PowerCrossLockRunOptions` = `{}`

Per-call options.

#### Returns

`Promise`\<`any`\>

Whatever `fn` returned.

***

### stats()

> **stats**(): `PowerCrossLockStats`

Counters, not durations.

**There is no `waits` counter, and its absence is deliberate.** The obvious way to
count contention is to ask the lock manager whether the name is already held — but
that is an async round trip, so it cannot be atomic with the acquisition that
follows, and reading it costs a round trip on every `run()` purely to fill in a
diagnostic. An earlier draft did exactly that, called it without awaiting, and
therefore counted a wait on **every** call. Contention is measured from the platform
instead, where it is authoritative: [waiterCount](#waitercount) and [query](#query).

#### Returns

`PowerCrossLockStats`

***

### waiterCount()

> **waiterCount**(`name`): `Promise`\<`number`\>

How many callers are queued for `name` right now.

Separate from [query](#query) because a queue depth is the number a caller actually
wants, and it is the one that says *why* a lock is slow.

#### Parameters

##### name

`string`

Lock name.

#### Returns

`Promise`\<`number`\>
