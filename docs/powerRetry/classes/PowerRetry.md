[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerRetry](../README.md) / PowerRetry

# Class: PowerRetry

PowerRetry

 PowerRetry

## Example

```ts
// The common case.
const data = await PowerRetry.run(() => fetch(url).then((r) => r.json()));

// Tail-latency control with a shared budget.
const budget = new PowerRetryBudget({ ratio: 0.2 });
const data = await PowerRetry.run(() => fetch(url).then((r) => r.json()), {
  backoff: 'decorrelated',
  budget,
  hedgeDelay: 200,
});
```

## Constructors

### Constructor

> **new PowerRetry**(`options?`): `PowerRetry`

#### Parameters

##### options?

`PowerRetryOptions` = `{}`

Defaults are listed on
  PowerRetryOptions. A `budget` given here is created once and
  shared by every [PowerRetry#run](#run) on this instance.

#### Returns

`PowerRetry`

## Properties

### \_budget

> **\_budget**: [`PowerRetryBudget`](PowerRetryBudget.md) \| `null`

`null`, a shared bucket, or a bucket created from a ratio here. A bucket
built at construction time is the only form that can ration retries
*across* calls, because that is the traffic a budget is about.

***

### \_options

> **\_options**: `PowerRetryOptions`

## Methods

### run()

> **run**(`fn`, `options?`): `Promise`\<`any`\>

Run `fn` with the instance defaults, overridden per call.

#### Parameters

##### fn

`Function`

The operation to run.

##### options?

`PowerRetryOptions` = `{}`

Per-call overrides.

#### Returns

`Promise`\<`any`\>

The resolved value of `fn`.

***

### run()

> `static` **run**(`fn`, `options?`): `Promise`\<`any`\>

Run `fn`, retrying it according to `options`.

#### Parameters

##### fn

`Function`

`(signal?: AbortSignal) => any`. It receives the
  attempt's `AbortSignal` when `attemptTimeout` or `hedgeDelay` is
  configured, and `undefined` otherwise. Honour the signal if you can: it
  is how a timed-out attempt and a losing hedge are stopped.

##### options?

`PowerRetryOptions` = `{}`

#### Returns

`Promise`\<`any`\>

The resolved value of the first attempt to succeed.

#### Throws

The last error, once attempts are exhausted, the budget is
  spent, or `retryIf` declines.
