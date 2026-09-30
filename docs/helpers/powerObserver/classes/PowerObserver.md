[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/powerObserver](../README.md) / PowerObserver

# Class: PowerObserver

## Constructors

### Constructor

> **new PowerObserver**(`initial`, `options?`): `PowerObserver`

Create a new PowerObserver.

#### Parameters

##### initial

`any`

Initial value

##### options?

`PowerObserverOptions` = `{}`

#### Returns

`PowerObserver`

## Properties

### \_distinct

> **\_distinct**: `boolean`

---

### \_map

> **\_map**: `Function` \| `null`

---

### \_mapped

> **\_mapped**: `any`

---

### \_mappedValid

> **\_mappedValid**: `boolean`

---

### \_pending

> **\_pending**: `boolean`

---

### \_pendingNext

> **\_pendingNext**: `any`

---

### \_pendingPrev

> **\_pendingPrev**: `any`

---

### \_scheduleMode

> **\_scheduleMode**: `string`

---

### \_scheduler

> **\_scheduler**: [`PowerScheduler`](../../powerScheduler/classes/PowerScheduler.md)

---

### \_subs

> **\_subs**: [`PowerSubscriberSet`](../../powerSubscriberSet/classes/PowerSubscriberSet.md)

---

### \_value

> **\_value**: `any`

## Accessors

### size

#### Get Signature

> **get** **size**(): `number`

Number of subscribers

##### Returns

`number`

---

### value

#### Get Signature

> **get** **value**(): `any`

Current value

##### Returns

`any`

#### Set Signature

> **set** **value**(`v`): `void`

Set value and schedule notification according to `async` option

##### Parameters

###### v

`any`

##### Returns

`void`

## Methods

### \_flushPending()

> **\_flushPending**(): `void`

Internal flush implementation

#### Returns

`void`

---

### clear()

> **clear**(): `void`

Remove all subscribers

#### Returns

`void`

---

### derive()

> **derive**(`fn`): `PowerObserver`

Create a **derived** observer: a new observer whose value is recomputed from
this one, and which only exists as long as something subscribes to it.

`map()` _mutates_ this observer's mapping and returns nothing; this is the
pure counterpart, so chains can be built without disturbing the source.

```js
const label = user.derive((u) => u.name).filter((n) => n.length > 0);
const off = label.subscribe((name) => render(name));
```

**The upstream subscription is created on first subscribe and released on
last unsubscribe.** That is the whole difficulty with derived observables
and the reason a naive version leaks: a chain of ten `derive` calls held by
one consumer keeps all ten upstreams alive, and a consumer that unsubscribes
and is collected leaves every one of them running. Nothing is subscribed
until someone asks, and everything is released when they stop.

**While nobody is subscribed, the derived value is a snapshot, not a live
value** — the value captured when the chain was built. That is the direct
cost of not subscribing, and it is why a consumer that wants a live value has
to subscribe.

#### Parameters

##### fn

(`value`, `prev`) => `any`

Derive the next value.

#### Returns

`PowerObserver`

A new observer, already holding `fn(this.value)`.

---

### distinct()

> **distinct**(): `PowerObserver`

Only notify when the value actually changes, using `Object.is` so `NaN`
equals itself and `-0` does not equal `0`. This is per-derived-observer and
does not change the source, unlike the `distinct` constructor option.

#### Returns

`PowerObserver`

---

### drain()

> **drain**(): `void`

Alias for flush()

#### Returns

`void`

---

### filter()

> **filter**(`predicate`): `PowerObserver`

Only notify subscribers when `predicate` passes. The derived value is the
last value that _passed_, so a filtered stream cannot be read as "the latest
upstream value".

#### Parameters

##### predicate

(`value`, `prev`) => `boolean`

#### Returns

`PowerObserver`

---

### flush()

> **flush**(): `void`

Flush any pending notification immediately. Useful for tests or shutdown.

#### Returns

`void`

---

### map()

> **map**(`fn`): `void`

Set or replace the mapping function used for notifications.

#### Parameters

##### fn

((`value`) => `any`) \| `null`

`null` clears the mapping. Anything
that is not a function and not `null` throws rather than silently
disabling mapping, because a typo'd option is otherwise invisible.

#### Returns

`void`

---

### subscribe()

> **subscribe**(`fn`): () => `boolean`

Subscribe to changes. Returns an unsubscribe function.

#### Parameters

##### fn

(`next`, `prev`) => `void`

#### Returns

() => `boolean`

---

### combineLatest()

> `static` **combineLatest**(...`sources`): `PowerObserver`

Combine several observers into one that emits whenever **any** of them
changes, with the latest value of each.

```js
const both = PowerObserver.combineLatest(a, b); // [a.value, b.value]
```

Like every derived observer, it subscribes upstream on first use and releases
on last unsubscribe.

#### Parameters

##### sources

...`PowerObserver`[]

#### Returns

`PowerObserver`
