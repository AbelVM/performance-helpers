[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerCircuit](../README.md) / PowerCircuit

# Class: PowerCircuit

## Constructors

### Constructor

> **new PowerCircuit**(`options?`): `PowerCircuit`

Create a PowerCircuit.

#### Parameters

##### options?

[`PowerCircuitOptions`](../interfaces/PowerCircuitOptions.md) = `{}`

#### Returns

`PowerCircuit`

## Properties

### \_failures

> **\_failures**: `number`

***

### \_openedAt

> **\_openedAt**: `number` \| `null`

***

### \_state

> **\_state**: `string`

Reset the circuit to `closed` and clear counters.

#### Returns

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

### call()

> **call**(`fn`): `Promise`\<`any`\>

#### Parameters

##### fn

`any`

#### Returns

`Promise`\<`any`\>

***

### reset()

> **reset**(): `void`

#### Returns

`void`
