[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerSubscriberSet](../README.md) / PowerSubscriberSet

# Class: PowerSubscriberSet

PowerSubscriberSet

Shared subscriber set helper used by event buses and observable stores.
Supports optional weak references, once-listeners, and max listener counts.

 PowerSubscriberSet

## Constructors

### Constructor

> **new PowerSubscriberSet**(`options?`): `PowerSubscriberSet`

#### Parameters

##### options?

`PowerSubscriberSetOptions` = `{}`

`weak` stores listeners
  behind `WeakRef`; `maxListeners` caps the set (`0` = unlimited).

#### Returns

`PowerSubscriberSet`

## Properties

### \_finalization

> **\_finalization**: `FinalizationRegistry`\<\{ `ref`: `WeakRef`\<`SubscriberListener`\>; \}\> \| `null`

***

### \_listeners

> **\_listeners**: `Set`\<`SubscriberEntry`\>

***

### \_maxListeners

> **\_maxListeners**: `number`

***

### \_onceMap

> **\_onceMap**: `WeakMap`\<`SubscriberListener`, `SubscriberListener`\>

***

### \_weak

> **\_weak**: `boolean`

## Accessors

### size

#### Get Signature

> **get** **size**(): `number`

Number of currently live listeners.

##### Returns

`number`

## Methods

### \_cleanup()

> **\_cleanup**(): `void`

Remove dead weak refs from the set.

#### Returns

`void`

***

### \_deref()

> **\_deref**(`entry`): `SubscriberListener` \| `undefined`

Resolve a stored entry to the live listener, or `undefined` when the weak
target has been collected.

#### Parameters

##### entry

`SubscriberEntry`

#### Returns

`SubscriberListener` \| `undefined`

***

### \_ensureFinalization()

> **\_ensureFinalization**(): `FinalizationRegistry`\<\{ `ref`: `WeakRef`\<`SubscriberListener`\>; \}\> \| `null`

Lazily build the `FinalizationRegistry` that prunes collected weak
listeners, and return it — or `null` when weak mode is off or the runtime
has no `FinalizationRegistry`, which is the signal to skip registration.

`clear()` drops the registry (that is the point of BUG-025), so this has to
be able to build a *new* one. Skipping the rebuild instead would silently
downgrade a cleared-and-reused set to GC-agnostic behaviour, where a dead
weak ref survives until some later `size`/iteration happens to sweep it.

#### Returns

`FinalizationRegistry`\<\{ `ref`: `WeakRef`\<`SubscriberListener`\>; \}\> \| `null`

***

### \_makeEntry()

> **\_makeEntry**(`fn`): `SubscriberEntry`

Wrap a listener for storage: a `WeakRef` in weak mode, the function itself
otherwise. Undefined when weak mode is on but the runtime has no `WeakRef`.

#### Parameters

##### fn

`SubscriberListener`

#### Returns

`SubscriberEntry`

***

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [dispose](#dispose-1), so `using set = new PowerSubscriberSet()`
releases the listeners at scope exit.

#### Returns

`void`

***

### \[iterator\]()

> **\[iterator\]**(): `Generator`\<`SubscriberListener`, `void`, `unknown`\>

Iterate live listeners in insertion order.

#### Returns

`Generator`\<`SubscriberListener`, `void`, `unknown`\>

#### Yields

***

### add()

> **add**(`fn`): () => `boolean`

Add a listener and return an unsubscribe function.

#### Parameters

##### fn

`SubscriberListener` \| `WeakRef`\<`SubscriberListener`\>

Listener function, or its WeakRef when `weak` mode is enabled.

#### Returns

Unsubscribe function that removes the listener.

() => `boolean`

***

### addOnce()

> **addOnce**(`fn`): () => `boolean`

Add a once listener and return an unsubscribe function.
The original listener will be removed after the first invocation.

#### Parameters

##### fn

`SubscriberListener`

Listener function.

#### Returns

Unsubscribe function.

() => `boolean`

***

### clear()

> **clear**(): `void`

#### Returns

`void`

***

### delete()

> **delete**(`fn`): `boolean`

Delete a listener by original function or once-wrapper.

#### Parameters

##### fn

`SubscriberListener` \| `WeakRef`\<`SubscriberListener`\>

Original listener function or its WeakRef wrapper.

#### Returns

`boolean`

`true` if a listener was removed, otherwise `false`.

***

### dispose()

> **dispose**(): `void`

Release every resource this instance holds: the listener registry is
emptied and the `FinalizationRegistry` is replaced, so its retained
callbacks become collectable.

Idempotent, and safe to call while the instance is idle. Exists so the
instance works with `using` / `await using`.

#### Returns

`void`

***

### forEach()

> **forEach**(`fn`): `void`

Iterate live listeners in insertion order and invoke a callback.

#### Parameters

##### fn

(`listener`) => `void`

Callback invoked for each live listener.

#### Returns

`void`

***

### reset()

> **reset**(): `void`

Alias for [PowerSubscriberSet#clear](#clear).

`clear()` here empties the container, and "reset" is a natural second word
for exactly that - so a caller who reaches for `reset()` on this class gets
the obvious thing instead of a `TypeError`. No limiter gets this alias: for
`PowerThrottle` and `PowerPermitGate`, `reset()` *refills* and `clear()`
would read as the opposite, and the two are deliberately not synonyms.

#### Returns

`void`

***

### values()

> **values**(): `SubscriberListener`[]

Return a safe array copy of live listeners.

#### Returns

`SubscriberListener`[]

Array of live listener functions.
