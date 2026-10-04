[**performance-helpers**](../../README.md)

***

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

***

### \_emission

> **\_emission**: `number`

***

### \_lastNow

> **\_lastNow**: `number` \| `null`

***

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

***

### \_now

> **\_now**: () => `number`

Clock for this limiter, and whether it was explicitly injected. See
`resolveLimiterNow` for why the flag is load-bearing: an injected clock
must outrank a value threaded in by a composition.

#### Returns

`number`

***

### \_nowExplicit

> **\_nowExplicit**: `boolean`

***

### \_onError

> **\_onError**: ((`arg0`) => `void`) \| `null`

***

### \_tat

> **\_tat**: `number`

***

### burst

> **burst**: `number`

***

### per

> **per**: `number`

***

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

***

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

`LimiterNowOptions` = `{}`

Per-call clock override.

#### Returns

`number`

A non-negative whole number.

***

### clear()

> **clear**(): `void`

Alias for [PowerGCRA#reset](#reset).

`reset()` here *is* a clear — it discards the one piece of stored state, so
both words describe the same act. Contrast the limiters that *hold* capacity
(`PowerThrottle`, `PowerPermitGate`), where `reset()` refills and `clear()`
would read as the opposite.

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

#### Returns

`void`

***

### getStats()

> **getStats**(): `object`

Alias for [stats](#stats), so a caller who learned `getStats()` from
`PowerPool` — the one class that has always spelled it this way — is not
handed `TypeError: x.getStats is not a function` here.

Nine helpers spell the reporting method `stats()` and `PowerPool` spelled it
`getStats()`, with no stated rule and nothing pinning it, which reached the
documentation as a false claim (`guides/metrics.md`, `llm.txt`). Both
spellings work everywhere now. `stats()` is canonical and this delegates to
it; `PowerPool` keeps `getStats` because renaming the largest surface in the
library would be a breaking change.

Written out per class rather than installed on the prototype on purpose: a
dynamic `Object.defineProperty` is invisible to `tsc`, so the generated
`types/` omitted it and a TypeScript caller got a type error on a method
that worked at runtime. That was the first implementation.

**No `@returns` tag, and that is load-bearing.** The first version carried a
hand-copied copy of the `stats()` return shape, on the reasoning that an
explicit type was safer. It is not: the copy went stale the moment a
concurrent change added `staleServes` and `expirations` to `PowerCache`
`.stats()`, and `test/statsNaming.test.js` failed. Inference gives a
byte-identical published type and cannot drift, because there is nothing to
keep in sync. `test/types.test-d.ts` asserts the two are mutually assignable,
which is the property a consumer relies on.

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

***

### reset()

> **reset**(): `void`

Clear the accumulated state, as if the limiter were brand new.

#### Returns

`void`

***

### retryAfter()

> **retryAfter**(`n?`, `options?`): `number`

Exact milliseconds until `tryConsume(n)` would succeed.

Grows with `n`, by `(n - 1) * emissionInterval` beyond the single-operation
wait. That is the batch's own span and it has to: a batch is admitted only
when the whole span fits inside the tolerance window, so waiting the
single-operation wait and then asking for five would be refused. The wait
this returns is the exact boundary — not an estimate, and not a value that
under-waits.

#### Parameters

##### n?

`number` = `1`

Number of operations the next call would consume.

##### options?

`LimiterNowOptions` = `{}`

Per-call clock override.

#### Returns

`number`

Milliseconds to wait; `0` when the call would succeed now.

***

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

***

### take()

> **take**(`n?`): \{ `ok`: `true`; \} \| \{ `ok`: `false`; `retryAfter`: `number`; \}

Consume, or return the exact wait needed.

#### Parameters

##### n?

`number` = `1`

#### Returns

\{ `ok`: `true`; \} \| \{ `ok`: `false`; `retryAfter`: `number`; \}

***

### tryConsume()

> **tryConsume**(`n?`, `options?`): `boolean`

#### Parameters

##### n?

`number` = `1`

##### options?

`LimiterNowOptions` = `{}`

Per-call clock override.

#### Returns

`boolean`

***

### tryReserve()

> **tryReserve**(`n?`, `options?`): \{ `ok`: `true`; `runAt`: `null`; \} \| \{ `ok`: `false`; `runAt`: `number`; \}

Consume, and on refusal report **the exact time** the batch would be admitted.

The capability is not missing — [PowerGCRA#retryAfter](#retryafter) already computes
the exact wait. What is missing is doing both **from one clock reading**:
`tryConsume()` followed by `retryAfter()` takes two, and this class's own
comments record that two spellings of the same arithmetic have already
disagreed in the last bit and admitted a batch `available()` had just called
unaffordable. A caller wiring an HTTP 429 needs both answers at once anyway.

`runAt` is an **absolute timestamp**, not a delay — an HTTP `Retry-After` and a
log line both want the instant, and converting one to the other is where a
caller gets it wrong. It is `null` on success because there is nothing to wait
for.

This mirrors `tryConsume`'s admission path line for line rather than calling
it, because calling it would cost the second reading this method exists to
avoid. `test/powerGCRA.test.js` asserts the two agree across a spread of
configurations, so a future change to either one that the other does not
follow fails rather than drifting.

#### Parameters

##### n?

`number` = `1`

Number of operations to reserve.

##### options?

`LimiterNowOptions` = `{}`

Per-call clock override.

#### Returns

\{ `ok`: `true`; `runAt`: `null`; \} \| \{ `ok`: `false`; `runAt`: `number`; \}

`runAt` is the
  absolute time the refused batch would be admitted.
