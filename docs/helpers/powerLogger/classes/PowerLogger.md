[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerLogger](../README.md) / PowerLogger

# Class: PowerLogger

## Constructors

### Constructor

> **new PowerLogger**(`level?`, `options?`): `PowerLogger`

Create a PowerLogger instance.

#### Parameters

##### level?

`number` = `0`

Initial debug level (0..3)

##### options?

`PowerLoggerOptions` = `{}`

The `PowerLoggerOptions` typedef
  already existed and already declared `name`/`formatter`/`output`; the
  constructor was taking a bare `{Object}` instead, which is why reading
  any of them was an error and a custom sink needed a cast.

#### Returns

`PowerLogger`

## Properties

### \_counters

> **\_counters**: `any`

***

### \_debugLevel

> **\_debugLevel**: `number`

***

### \_format

> **\_format**: `"json"` \| `"text"`

***

### \_formatter

> **\_formatter**: ((`payload`) => `string` \| `PowerLoggerPayload` \| `null`) \| `null`

***

### \_output

> **\_output**: ((`payload`) => `void`) \| `null`

***

### name

> **name**: `string` \| `null`

## Methods

### \_emitSinkError()

> **\_emitSinkError**(`err`): `void`

Report a failure raised by a user-supplied log sink.

A sink that throws must not be able to take the logger - and therefore the
pool, cache or circuit that owns it - down with it, but the failure still
has to be visible somewhere. Escalate to `console.error` once, guarded, and
give up if that fails too.

#### Parameters

##### err

`any`

The value thrown by the sink.

#### Returns

`void`

***

### debug()

> **debug**(...`args`): `void`

Log using `console.debug` when level >= 3 (alias for verbose debug output).
Accepts values or functions (lazy evaluated).
Supports JSON mode similar to other methods.

#### Parameters

##### args

...`any`[]

#### Returns

`void`

***

### error()

> **error**(...`args`): `void`

Log an error-level message when debug level is >= 1.
Accepts values or functions (lazy evaluated).

Errors are formatted on the way through rather than left to the transport,
so a sink always receives a readable message instead of an `Error` object.

#### Parameters

##### args

...`any`[]

#### Returns

`void`

***

### getDebugCounters()

> **getDebugCounters**(): `Record`\<`string`, `number`\>

Read counters as a plain object snapshot.

#### Returns

`Record`\<`string`, `number`\>

***

### getDebugLevel()

> **getDebugLevel**(): `number`

Get the current debug level.

#### Returns

`number`

The configured debug level (0..3)

***

### incrementCounter()

> **incrementCounter**(`name`): `void`

Increment an internal named counter (no-op when debug is disabled).
Useful for lightweight instrumentation in tests.

#### Parameters

##### name

`string`

#### Returns

`void`

***

### info()

> **info**(...`args`): `void`

Log an info-level message when debug level is >= 3.

#### Parameters

##### args

...`any`[]

#### Returns

`void`

***

### isDebug()

> **isDebug**(): `boolean`

Convenience: whether any debugging is enabled (level > 0).

#### Returns

`boolean`

***

### isDebugLevel()

> **isDebugLevel**(`level?`): `boolean`

Determine whether the current debug level is >= `level`.

#### Parameters

##### level?

`number` = `1`

#### Returns

`boolean`

***

### log()

> **log**(...`args`): `void`

Log a verbose message when debug level is >= 3.

#### Parameters

##### args

...`any`[]

#### Returns

`void`

***

### resetDebugCounters()

> **resetDebugCounters**(): `void`

Reset all internal counters (test helper).

#### Returns

`void`

***

### setDebugLevel()

> **setDebugLevel**(`level`): `void`

Set the global debug level.

Coerced with `Number()` and clamped to 0..3; anything that does not coerce
to a finite non-negative number leaves the level at 0. See
coerceDebugLevel for what the coercion accepts.

#### Parameters

##### level

`number`

Integer in range 0..3

#### Returns

`void`

***

### table()

> **table**(...`args`): `void`

Display tabular data. Uses `console.table` when available.
In JSON mode emits `{ level: 'table', msg: args, ts }` where `msg` is an array of arguments.

#### Parameters

##### args

...`any`[]

#### Returns

`void`

***

### warn()

> **warn**(...`args`): `void`

Log a warning-level message when debug level is >= 2.

#### Parameters

##### args

...`any`[]

#### Returns

`void`
