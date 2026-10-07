[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerBrownout](../README.md) / PowerBrownout

# Class: PowerBrownout

Caller-controlled brownout policy for optional work.

 PowerBrownout

## Constructors

### Constructor

> **new PowerBrownout**(`options?`): `PowerBrownout`

#### Parameters

##### options?

###### disabledKinds?

`string`[]

###### threshold?

`number`

#### Returns

`PowerBrownout`

## Properties

### \_decisions

> **\_decisions**: `number`

***

### \_disabledKinds

> **\_disabledKinds**: `Set`\<`string`\>

***

### \_pressure

> **\_pressure**: `number`

***

### \_shed

> **\_shed**: `number`

***

### threshold

> **threshold**: `number`

## Methods

### allows()

> **allows**(`kind`): `boolean`

#### Parameters

##### kind

`string`

#### Returns

`boolean`

***

### disable()

> **disable**(`kind`, `disabled?`): `object`

#### Parameters

##### kind

`string`

##### disabled?

`boolean` = `true`

#### Returns

`object`

##### active

> **active**: `boolean`

##### decisions

> **decisions**: `number`

##### disabledKinds

> **disabledKinds**: `string`[]

##### pressure

> **pressure**: `number`

##### shed

> **shed**: `number`

##### threshold

> **threshold**: `number`

***

### getStats()

> **getStats**(): `object`

#### Returns

`object`

##### active

> **active**: `boolean`

##### decisions

> **decisions**: `number`

##### disabledKinds

> **disabledKinds**: `string`[]

##### pressure

> **pressure**: `number`

##### shed

> **shed**: `number`

##### threshold

> **threshold**: `number`

***

### setPressure()

> **setPressure**(`pressure`): `object`

#### Parameters

##### pressure

`number`

#### Returns

`object`

##### active

> **active**: `boolean`

##### decisions

> **decisions**: `number`

##### disabledKinds

> **disabledKinds**: `string`[]

##### pressure

> **pressure**: `number`

##### shed

> **shed**: `number`

##### threshold

> **threshold**: `number`

***

### stats()

> **stats**(): `object`

Explain the current brownout state.

#### Returns

`object`

##### active

> **active**: `boolean`

##### decisions

> **decisions**: `number`

##### disabledKinds

> **disabledKinds**: `string`[]

##### pressure

> **pressure**: `number`

##### shed

> **shed**: `number`

##### threshold

> **threshold**: `number`
