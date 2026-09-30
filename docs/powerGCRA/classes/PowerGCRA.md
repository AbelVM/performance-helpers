[**performance-helpers**](../../README.md)

---

[performance-helpers](../../README.md) / [powerGCRA](../README.md) / PowerGCRA

# Class: PowerGCRA

A GCRA rate limiter.

## Example

```ts
const limiter = new PowerGCRA({ rate: 100, per: 1000, burst: 10 });
if (limiter.tryConsume()) doWork();
else setTimeout(doWork, limiter.retryAfter());
```

## Constructors

### Constructor

> **new PowerGCRA**(`options?`): `PowerGCRA`

#### Parameters

##### options?

[`PowerGCRAOptions`](../interfaces/PowerGCRAOptions.md)

`rate` is required in practice: the
constructor throws a `TypeError` without it. The parameter stays optional
because that throw is the documented way a missing `rate` is reported, and
`new PowerGCRA()` must stay callable to reach it.

#### Returns

`PowerGCRA`

## Properties

### \_delayTolerance

> **\_delayTolerance**: `number`

---

### \_emission

> **\_emission**: `number`

---

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

---

### \_now

> **\_now**: () => `number`

Clock for this limiter, and whether it was explicitly injected. See
`resolveLimiterNow` for why the flag is load-bearing: an injected clock
must outrank a value threaded in by a composition.

#### Returns

`number`

---

### \_nowExplicit

> **\_nowExplicit**: `boolean`

---

### \_onError

> **\_onError**: ((`arg0`) => `void`) \| `null`

---

### \_tat

> **\_tat**: `number`

---

### burst

> **burst**: `number`

---

### per

> **per**: `number`

---

### rate

> **rate**: `number`

## Accessors

### hasCapacity

#### Get Signature

> **get** **hasCapacity**(): `boolean`

Whether the limiter would accept a single operation right now, without
consuming it. Same shape as `PowerThrottle.available()` for composition.

##### Returns

`boolean`

## Methods

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

---

### available()

> **available**(`options?`): `number`

How many operations can be consumed at this instant, given the burst
ceiling.

A batch is admitted behind a single check, so the count at an idle instant
is `burst + 1`, not `burst`: with no history every call up to and including
the `burst`-th extra one still finds `tat <= now + delayTolerance`. This
also has to be right for composition - `PowerRateLimit` pre-checks
`available()` and refuses immediately when it is below the ask, so
reporting `0` on a fresh limiter would make GCRA refuse everything.

#### Parameters

##### options?

#### Returns

`number`

A non-negative whole number.

---

### clear()

> **clear**(): `void`

Alias for [PowerGCRA#reset](#reset).

`reset()` here _is_ a clear — it discards the one piece of stored state, so
both words describe the same act. Contrast the limiters that _hold_ capacity
(`PowerThrottle`, `PowerPermitGate`), where `reset()` refills and `clear()`
would read as the opposite.

#### Returns

`void`

---

### dispose()

> **dispose**(): `void`

#### Returns

`void`

---

### reset()

> **reset**(): `void`

Clear the accumulated state, as if the limiter were brand new.

#### Returns

`void`

---

### retryAfter()

> **retryAfter**(`n?`, `options?`): `number`

Exact milliseconds until `tryConsume()` would succeed.

#### Parameters

##### n?

`number` = `1`

Number of operations the next call would consume.

##### options?

#### Returns

`number`

Milliseconds to wait; `0` when the call would succeed now.

---

### stats()

> **stats**(): `object`

Serializable snapshot of the limiter's configuration and state.

`tat` is `null` - not `-Infinity` - when there is no accumulated history
(fresh instance, or after `reset()` / `dispose()`), because `-Infinity` does
not survive a JSON round-trip: `JSON.stringify` turns it into `null`
anyway, so a snapshot that claimed `number` was only true in memory. A
consumer that reads the snapshot back therefore already had to handle
`null`; the declared type now says so.

#### Returns

`object`

##### burst

> **burst**: `number`

##### delayTolerance

> **delayTolerance**: `number`

##### emissionInterval

> **emissionInterval**: `number`

##### per

> **per**: `number`

##### rate

> **rate**: `number`

##### tat

> **tat**: `number` \| `null`

---

### take()

> **take**(`n?`): \{ `ok`: `true`; \} \| \{ `ok`: `false`; `retryAfter`: `number`; \}

Consume, or return the exact wait needed.

#### Parameters

##### n?

`number` = `1`

#### Returns

\{ `ok`: `true`; \} \| \{ `ok`: `false`; `retryAfter`: `number`; \}

---

### tryConsume()

> **tryConsume**(`n?`, `options?`): `boolean`

Try to consume one operation.

#### Parameters

##### n?

`number` = `1`

Number of operations to consume.

##### options?

#### Returns

`boolean`

`true` when the request fits inside the current budget.
