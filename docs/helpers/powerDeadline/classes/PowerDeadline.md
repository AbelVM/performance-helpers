[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerDeadline](../README.md) / PowerDeadline

# Class: PowerDeadline

Deadline-aware async helper for timeout, retry budget, and abort metadata.

Use `PowerDeadline` to wrap async work with per-attempt timeouts, a total
deadline for the whole operation, and optional retry/backoff behavior.

 PowerDeadline

## Constructors

### Constructor

> **new PowerDeadline**(`options?`): `PowerDeadline`

Create a configured `PowerDeadline` instance.

#### Parameters

##### options?

`PowerDeadlineOptions` = `{}`

Default options applied to every `run()` invocation.

#### Returns

`PowerDeadline`

## Properties

### \_now

> **\_now**: () => `number`

Get a high-resolution timestamp in milliseconds since the epoch.

This function prefers `performance.timeOrigin + performance.now()` when
available and reasonably close to `Date.now()` to provide higher resolution
timestamps. On Node.js it uses `process.hrtime.bigint()` with an epoch offset
when available. Falls back to `Date.now()` if nothing
better is available or when offsets appear to diverge (e.g. in some
test harnesses).

**The wall-clock cross-check is what makes this clock movable, and that is
sometimes required.** It is what lets a test harness that fakes `Date.now()`
drive a helper's notion of time, and it is why `PowerCron.nextRunAt` can be
documented as epoch milliseconds. The price is that a helper which only ever
*subtracts* inherits the wall clock's ability to jump - see
[monoMs](../../../utils/now/functions/monoMs.md) for the measurement and for the four helpers that use it
instead.

#### Returns

`number`

Milliseconds since epoch (floating point for higher resolution).

***

### \_options

> **\_options**: `PowerDeadlineOptions`

## Methods

### run()

> **run**(`fn`, `options?`): `Promise`\<`any`\>

Run a function with the configured deadline options merged with per-call options.

#### Parameters

##### fn

`Function`

Async function to execute.

##### options?

`PowerDeadlineOptions` = `{}`

#### Returns

`Promise`\<`any`\>

***

### run()

> `static` **run**(`fn`, `options?`): `Promise`\<`any`\>

Run a function with deadline semantics.

#### Parameters

##### fn

`Function`

Async function to execute.

##### options?

`PowerDeadlineOptions` = `{}`

#### Returns

`Promise`\<`any`\>
