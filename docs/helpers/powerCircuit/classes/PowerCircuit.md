[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerCircuit](../README.md) / PowerCircuit

# Class: PowerCircuit

PowerCircuit

Circuit-breaker primitive that short-circuits calls after repeated failures.
Use for isolating flaky downstream dependencies and to avoid cascading failures.

 PowerCircuit

## Constructors

### Constructor

> **new PowerCircuit**(`options?`): `PowerCircuit`

#### Parameters

##### options?

`PowerCircuitOptions` = `{}`

`threshold` and `timeout` default
  to 5 and 30s; `onStateChange` and `eventBus` are optional sinks. `timeout`
  is the *base* open window: consecutive trips grow it exponentially up to
  `maxTimeout` and jitter the result.

#### Returns

`PowerCircuit`

## Properties

### \_bus

> **\_bus**: [`PowerEventBus`](../../powerEventBus/classes/PowerEventBus.md)\<`Record`\<`string`, `any`\>\> \| `null`

***

### \_consecutiveOpens

> **\_consecutiveOpens**: `number`

Consecutive entries into `open`, which drive the exponential growth.
Reset to 0 whenever the circuit proves the dependency is healthy again.

***

### \_failures

> **\_failures**: `number`

***

### \_halfOpenAnnounced

> **\_halfOpenAnnounced**: `boolean`

***

### \_maxTimeout

> **\_maxTimeout**: `number`

***

### \_now

> **\_now**: () => `number`

A **monotonic** high-resolution timestamp in milliseconds since the epoch.

Same ladder, same sources, same epoch mapping as [nowMs](../../../utils/now/functions/nowMs.md) - and one
difference: `Date.now()` is never read, so the value cannot be moved by a
wall-clock adjustment. The epoch offset is captured once at module load, so
the result is a real epoch timestamp that only ever increases.

Use it for **delta arithmetic**, where only the difference between two
readings is ever used: rate limiters, circuit-breaker windows, token-bucket
refill. Use [nowMs](../../../utils/now/functions/nowMs.md) for anything a caller will read as an instant -
`PowerCron.nextRunAt`, a log line, an HTTP `Retry-After`.

**Why, measured.** `nowMs()` is two clock reads, and the second exists only to detect
a divergence. Within a second of wall time the guard passes and the value
tracks `performance`, so the limiter's elapsed-time arithmetic is sound -
but a clock adjusted by more than a second fails the guard, and from that
moment the helper silently reads `Date.now()`. Two measurements of the
consequence, both with **zero** real milliseconds elapsed:

- `PowerGCRA({rate: 10, per: 1000, burst: 1})` saturated at `available() ===
  0` reported `available() === 2` and admitted after the wall clock stepped
  forward 5 s. `2` is `_ceiling()`, so that is the whole burst, granted.
- `PowerCircuit({threshold: 1, timeout: 60000})` reported `half-open` after a
  60 s forward step, so a dependency that had been failing for 1 ms was
  offered a trial call.

Both are **forward** steps, which is worth stating because the obvious
reading is backwards: a backward step is harmless to these helpers, because
`PowerGCRA`'s `Math.max(now, _tat)` clamp and `PowerCircuit`'s `nowMs() -
_openedAt < _openWindowMs` comparison both keep interpreting an earlier
reading as "not much time has passed". It is the jump forward that hands out
budget nobody spent.

**The cost, stated rather than hidden.** A consumer who fakes `Date.now()` to
drive a limiter's clock will stop doing so - the four helpers using this
clock ignore it. The supported injection point is a limiter's `now` option,
which has always been authoritative (`resolveLimiterNow` gives it precedence
over everything, including a per-call value). `PowerCircuit` has no `now`
option, so for that class a faked `Date.now()` was never a documented way in
and is not one now.

**The guarantee is by source, not by clamping.** Both sources this can reach -
`performance.now()` and `process.hrtime.bigint()` - are monotonic by
specification, and the epoch offsets (`performance.timeOrigin`,
`_hrtimeEpochOffset`) are fixed for the module's lifetime. A last-value floor
was considered and rejected: it would prevent the value going *backwards*
while still permitting the forward jumps that are the actual defect, so it
would cost a branch on the hot path and a module-level mutable to fix the
wrong direction. The `Date.now()` fallback is reached only on a platform
offering neither high-resolution clock, where nothing monotonic exists to use.

#### Returns

`number`

Milliseconds since epoch (floating point), non-decreasing.

***

### \_openedAt

> **\_openedAt**: `number` \| `null`

***

### \_openWindowMs

> **\_openWindowMs**: `number`

The jittered window for the *current* `open` period, drawn once when the
circuit opened. It must be stored rather than re-drawn: the open check
runs on every `call()` and every `state` read, and a per-call draw would
make the window fluctuate, so the breaker would flap instead of holding.

***

### \_state

> **\_state**: `CircuitState`

***

### \_threshold

> **\_threshold**: `number`

***

### \_timeout

> **\_timeout**: `number`

***

### \_trialInFlight

> **\_trialInFlight**: `boolean`

***

### lastError

> **lastError**: `any`

***

### onStateChange

> **onStateChange**: ((`state`, `reason?`) => `void`) \| `null`

## Accessors

### failures

#### Get Signature

> **get** **failures**(): `number`

##### Returns

`number`

***

### state

#### Get Signature

> **get** **state**(): `CircuitState`

##### Returns

`CircuitState`

## Methods

### \_drawOpenWindow()

> **\_drawOpenWindow**(): `number`

Draw the open window for a trip: exponential backoff on the base timeout,
capped, then equal jitter.

The exponential part is what stops a genuinely-down dependency from being
probed at a fixed rate forever; the jitter is what stops a *fleet* of
clients from probing it in lockstep. With a fixed window, every circuit
guarding the same dependency opened on the same tick and retried on the
same tick, so the first post-timeout request arrived as an N-wide burst
that re-tripped the breaker before it had recovered — a self-inflicted
thundering herd, and the exact failure the breaker exists to prevent.

#### Returns

`number`

The window in ms, always at least half the computed
  backoff. See `DEFAULT_CIRCUIT_MIN_JITTER_RATIO` for why this is not full
  jitter.

***

### \_setState()

> **\_setState**(`newState`, `reason?`): `void`

Move to a new state, stamping `_openedAt`, notifying `onStateChange` and
emitting on the bus. A no-op when the state is unchanged.

#### Parameters

##### newState

`CircuitState`

##### reason?

`string`

#### Returns

`void`

***

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

Asynchronous disposal hook (thin wrapper). Forwards to sync disposal.

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [dispose](#dispose-1), so `using x = new X()` releases the instance
deterministically at scope exit.

#### Returns

`void`

***

### call()

> **call**(`fn`): `Promise`\<`any`\>

Execute a function under circuit-breaker protection.

If the circuit is `open`, this will throw an error with `code === 'ECIRCUITOPEN'`.
When in `half-open` state a single trial call is allowed.

#### Parameters

##### fn

() => `any`

Async or sync function to execute.

#### Returns

`Promise`\<`any`\>

Resolves with the function's result.

#### Throws

If the circuit is open or if `fn` throws/rejects.

***

### dispose()

> **dispose**(): `void`

Release the instance: reset it, then make it inert.

Idempotent, and safe to call while the instance is idle. Exists so the
instance works with `using` / `await using` and gives callers an explicit
name to call.

**A disposed circuit stays disposed** (RES-026). This used to replace only
`reset`, while the comment claimed "a late call is a no-op" — so a late
`call()` ran `fn` and put the circuit straight back to work. It was a phantom
API: a `dispose()` that released nothing, on a class that holds no resource to
release. Disposal here is a **state reset**, which is what a lazy helper owes
its caller, and a state reset has to cover the only method that does work.

#### Returns

`void`

***

### reset()

> **reset**(): `void`

Force the circuit back to the `closed` state and clear failures.

#### Returns

`void`
