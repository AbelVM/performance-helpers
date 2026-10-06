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
