[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerCircuit](../README.md) / PowerCircuit

# Class: PowerCircuit

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
