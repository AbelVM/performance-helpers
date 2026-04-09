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

#### Returns

`PowerCircuit`

## Properties

### \_bus

> **\_bus**: [`PowerEventBus`](../../powerEventBus/classes/PowerEventBus.md) \| `null`

***

### \_failures

> **\_failures**: `number`

***

### \_openedAt

> **\_openedAt**: `number` \| `null`

***

### \_state

> **\_state**: `string`

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

> **lastError**: `unknown`

***

### onStateChange

> **onStateChange**: `any`

## Accessors

### failures

#### Get Signature

> **get** **failures**(): `number`

##### Returns

`number`

***

### state

#### Get Signature

> **get** **state**(): `string`

##### Returns

`string`

## Methods

### \_setState()

> **\_setState**(`newState`, `reason`): `void`

#### Parameters

##### newState

`any`

##### reason

`any`

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

`Function`

Async function to execute.

#### Returns

`Promise`\<`any`\>

Resolves with the function's result.

#### Throws

If the circuit is open or if `fn` throws/rejects.

***

### reset()

> **reset**(): `void`

Force the circuit back to the `closed` state and clear failures.

#### Returns

`void`
