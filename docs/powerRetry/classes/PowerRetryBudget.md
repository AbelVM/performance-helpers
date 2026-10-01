[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerRetry](../README.md) / PowerRetryBudget

# Class: PowerRetryBudget

A token bucket that bounds how much retry traffic a dependency may receive.

The rule is the one from the Google SRE Workbook's *Handling Overload*
chapter: the budget is refilled in proportion to the traffic you are
*already* sending, and each retry spends a token. During a partial outage
the bucket drains, so retries throttle exactly when the dependency can least
afford them.

The bucket starts **full**. A token bucket that started empty would refuse
the first retry of a fresh budget, because one request funds 0.2 of a token
and a retry costs a whole one — so the protection would engage on a healthy
dependency and disengage on the sick one, which is backwards.

 PowerRetryBudget

## Example

```ts
const budget = new PowerRetryBudget({ ratio: 0.2 });
await PowerRetry.run(call, { budget, maxAttempts: 5 });
```

## Constructors

### Constructor

> **new PowerRetryBudget**(`options?`): `PowerRetryBudget`

#### Parameters

##### options?

`PowerRetryBudgetOptions` = `{}`

`ratio` defaults to 0.2 (the
  top of the SRE-recommended 10-20 % band) and `capacity` to 10 retry
  tokens. See PowerRetryBudgetOptions.

#### Returns

`PowerRetryBudget`

## Properties

### \_capacity

> **\_capacity**: `number`

***

### \_funded

> **\_funded**: `number`

***

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

***

### \_ratio

> **\_ratio**: `number`

***

### \_refused

> **\_refused**: `number`

***

### \_retries

> **\_retries**: `number`

***

### \_tokens

> **\_tokens**: `number`

Full on construction — see the class note for why an empty bucket is wrong.

## Accessors

### capacity

#### Get Signature

> **get** **capacity**(): `number`

The most retry tokens the bucket will hold.

##### Returns

`number`

***

### ratio

#### Get Signature

> **get** **ratio**(): `number`

The ratio of requests to retries this budget permits, in `(0, 1]`.

##### Returns

`number`

## Methods

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

***

### available()

> **available**(): `number`

Current retry tokens available.

#### Returns

`number`

***

### dispose()

> **dispose**(): `void`

Release the metrics registration. Safe to call more than once.

`reset()` deliberately does not do this — a budget can be reset and reused,
and unregistering on every reset would make the series flap. `dispose()` is
the terminal teardown, and it is new here for the reason
`guides/metrics.md` gives: a disposed budget that stays registered is sampled
forever, and its `stats()` still answers, so nothing fails visibly.

#### Returns

`void`

***

### getStats()

> **getStats**(): `PowerRetryBudgetStats`

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

`PowerRetryBudgetStats`

***

### recordRequest()

> **recordRequest**(): `number`

Fund the budget by one request's worth of tokens.

Called once per `PowerRetry.run()`, not per attempt: a retry is a request
the dependency did not ask for, so letting retries fund the bucket would
let a retry storm pay for itself.

#### Returns

`number`

The token count after funding.

***

### reset()

> **reset**(): `void`

Refill the bucket to capacity and zero the counters.

#### Returns

`void`

***

### stats()

> **stats**(): `PowerRetryBudgetStats`

A snapshot of the budget, for logging and for deciding whether a refusal
was routine or a sign the dependency is genuinely sick.

#### Returns

`PowerRetryBudgetStats`

***

### tryConsumeRetry()

> **tryConsumeRetry**(): `boolean`

Try to spend one retry token.

#### Returns

`boolean`

`false` when the budget is exhausted and the retry must
  not be sent.
