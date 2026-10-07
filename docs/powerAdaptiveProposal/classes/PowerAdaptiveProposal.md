[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerAdaptiveProposal](../README.md) / PowerAdaptiveProposal

# Class: PowerAdaptiveProposal

A bounded controller for opt-in adaptive settings.

`signal > 0` requests a decrease, `signal < 0` requests an increase, and
values near zero are held by hysteresis. The caller supplies the signal so
this primitive stays independent of transport, queue, and latency policy.

 PowerAdaptiveProposal

## Constructors

### Constructor

> **new PowerAdaptiveProposal**(`options?`): `PowerAdaptiveProposal`

#### Parameters

##### options?

`PowerAdaptiveProposalOptions` = `{}`

#### Returns

`PowerAdaptiveProposal`

## Properties

### \_adjustments

> **\_adjustments**: `number`

***

### \_cooldown

> **\_cooldown**: `number`

***

### \_hysteresis

> **\_hysteresis**: `number`

***

### \_last

> **\_last**: `string`

***

### \_lastDirection

> **\_lastDirection**: `number`

***

### \_max

> **\_max**: `number`

***

### \_maxStep

> **\_maxStep**: `number`

***

### \_min

> **\_min**: `number`

***

### \_peakSignal

> **\_peakSignal**: `number`

***

### \_remaining

> **\_remaining**: `number`

***

### \_reversals

> **\_reversals**: `number`

***

### \_value

> **\_value**: `number`

## Accessors

### value

#### Get Signature

> **get** **value**(): `number`

Current proposed value.

##### Returns

`number`

## Methods

### \_result()

> **\_result**(`changed`, `signal`): `object`

#### Parameters

##### changed

`any`

##### signal

`any`

#### Returns

`object`

##### changed

> **changed**: `any`

##### confidence

> **confidence**: `number`

##### cooldownRemaining

> **cooldownRemaining**: `number`

##### reason

> **reason**: `string`

##### signal

> **signal**: `any`

##### value

> **value**: `number`

***

### getStats()

> **getStats**(): `object`

Alias for [stats](#stats).

#### Returns

`object`

##### adjustments

> **adjustments**: `number`

##### atMax

> **atMax**: `boolean`

##### atMin

> **atMin**: `boolean`

##### max

> **max**: `number`

##### min

> **min**: `number`

##### peakSignal

> **peakSignal**: `number`

##### reason

> **reason**: `string`

##### reversals

> **reversals**: `number`

##### value

> **value**: `number`

***

### propose()

> **propose**(`signal`): `PowerAdaptiveProposalResult`

Propose a bounded adjustment.

#### Parameters

##### signal

`number`

Positive means congestion; negative means recovery.

#### Returns

`PowerAdaptiveProposalResult`

***

### restore()

> **restore**(`snapshot`): `object`

Restore a previously captured state without bypassing the controller bounds.

#### Parameters

##### snapshot

`any`

#### Returns

`object`

##### reason

> **reason**: `string`

##### remaining

> **remaining**: `number`

##### value

> **value**: `number`

##### version

> **version**: `number` = `1`

***

### rollback()

> **rollback**(`value?`): `object`

Roll back one proposal to a prior value.

#### Parameters

##### value?

`number` = `...`

#### Returns

`object`

##### changed

> **changed**: `any`

##### confidence

> **confidence**: `number`

##### cooldownRemaining

> **cooldownRemaining**: `number`

##### reason

> **reason**: `string`

##### signal

> **signal**: `any`

##### value

> **value**: `number`

***

### snapshot()

> **snapshot**(): `object`

Return the bounded controller state for persistence across restarts.

#### Returns

`object`

##### reason

> **reason**: `string`

##### remaining

> **remaining**: `number`

##### value

> **value**: `number`

##### version

> **version**: `number` = `1`

***

### stats()

> **stats**(): `object`

Stability counters for tuning the controller against real workloads.

#### Returns

`object`

##### adjustments

> **adjustments**: `number`

##### atMax

> **atMax**: `boolean`

##### atMin

> **atMin**: `boolean`

##### max

> **max**: `number`

##### min

> **min**: `number`

##### peakSignal

> **peakSignal**: `number`

##### reason

> **reason**: `string`

##### reversals

> **reversals**: `number`

##### value

> **value**: `number`
