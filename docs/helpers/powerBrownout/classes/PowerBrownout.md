[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerBrownout](../README.md) / PowerBrownout

# Class: PowerBrownout

## Constructors

### Constructor

> **new PowerBrownout**(`options?`): `PowerBrownout`

#### Parameters

##### options?

###### adaptive?

`boolean` \| \{ `alpha?`: `number`; `margin?`: `number`; `max?`: `number`; `min?`: `number`; \}

###### disabledKinds?

`string`[]

###### threshold?

`number`

#### Returns

`PowerBrownout`

## Properties

### \_adaptive

> **\_adaptive**: `object`

#### additiveIncrease

> **additiveIncrease**: `number`

#### alpha

> **alpha**: `number`

#### beta

> **beta**: `number`

#### enabled

> **enabled**: `boolean`

#### margin

> **margin**: `number`

#### max

> **max**: `number`

#### min

> **min**: `number`

***

### \_baseThreshold

> **\_baseThreshold**: `number`

***

### \_decisions

> **\_decisions**: `number`

***

### \_disabledKinds

> **\_disabledKinds**: `Set`\<`string`\>

***

### \_pressure

> **\_pressure**: `number`

***

### \_pressureEwma

> **\_pressureEwma**: `any`

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

##### adaptive

> **adaptive**: `boolean`

##### baseThreshold

> **baseThreshold**: `number`

##### decisions

> **decisions**: `number`

##### disabledKinds

> **disabledKinds**: `string`[]

##### pressure

> **pressure**: `number`

##### pressureEwma

> **pressureEwma**: `any`

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

##### adaptive

> **adaptive**: `boolean`

##### baseThreshold

> **baseThreshold**: `number`

##### decisions

> **decisions**: `number`

##### disabledKinds

> **disabledKinds**: `string`[]

##### pressure

> **pressure**: `number`

##### pressureEwma

> **pressureEwma**: `any`

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

##### adaptive

> **adaptive**: `boolean`

##### baseThreshold

> **baseThreshold**: `number`

##### decisions

> **decisions**: `number`

##### disabledKinds

> **disabledKinds**: `string`[]

##### pressure

> **pressure**: `number`

##### pressureEwma

> **pressureEwma**: `any`

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

##### adaptive

> **adaptive**: `boolean`

##### baseThreshold

> **baseThreshold**: `number`

##### decisions

> **decisions**: `number`

##### disabledKinds

> **disabledKinds**: `string`[]

##### pressure

> **pressure**: `number`

##### pressureEwma

> **pressureEwma**: `any`

##### shed

> **shed**: `number`

##### threshold

> **threshold**: `number`
