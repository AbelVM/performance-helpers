[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/powerScheduler](../README.md) / PowerScheduler

# Class: PowerScheduler

## Constructors

### Constructor

> **new PowerScheduler**(`flushFn`, `options?`): `PowerScheduler`

#### Parameters

##### flushFn

`Function`

Function called when the scheduled work is flushed.

##### options?

`PowerSchedulerOptions` = `{}`

Scheduling and error handling options.

#### Returns

`PowerScheduler`

## Properties

### \_flushFn

> **\_flushFn**: `Function`

---

### \_generation

> **\_generation**: `number`

---

### \_onError

> **\_onError**: ((`error`) => `void`) \| `null`

---

### \_scheduled

> **\_scheduled**: `boolean`

---

### \_scheduling

> **\_scheduling**: `"microtask"` \| `"macrotask"` \| `"yield"`

---

### \_timer

> **\_timer**: [`MacrotaskHandle`](../type-aliases/MacrotaskHandle.md) \| \{ `cancel`: () => `void`; \} \| `null`

## Accessors

### scheduled

#### Get Signature

> **get** **scheduled**(): `boolean`

Whether a flush is currently scheduled.

##### Returns

`boolean`

---

### strategy

#### Get Signature

> **get** **strategy**(): `object`

The strategy this scheduler was _configured_ with, and whether the runtime
can actually honour it.

Both halves, because they can differ: `scheduling: 'yield'` falls back to a
macrotask where `scheduler.yield()` does not exist, and without this a
caller has no way to know it is running on the fallback. The fallback is a
degradation in _ordering_, not correctness — the flush still happens
promptly — which is exactly why it should be visible rather than silent.

##### Returns

`object`

###### scheduling

> **scheduling**: `"microtask"` \| `"macrotask"` \| `"yield"`

###### supported

> **supported**: `boolean`

## Methods

### \_run()

> **\_run**(): `void`

#### Returns

`void`

---

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [dispose](#dispose-1), so `using x = new X()` releases the instance
deterministically at scope exit.

#### Returns

`void`

---

### cancel()

> **cancel**(): `void`

Cancel any scheduled flush without invoking the callback.

#### Returns

`void`

---

### dispose()

> **dispose**(): `void`

Release every resource this instance holds.

Idempotent, and safe to call while the instance is idle. Exists so the
instance works with `using` / `await using` and gives callers an explicit
name to call.

#### Returns

`void`

---

### flush()

> **flush**(): `void`

Flush immediately if a callback is scheduled.

#### Returns

`void`

---

### schedule()

> **schedule**(): `void`

Schedule the flush callback once.

#### Returns

`void`
