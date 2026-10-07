[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/metrics](../README.md) / createObservation

# Function: createObservation()

> **createObservation**(`series`, `options?`): `object`

Add explicit sampling metadata to a flat series.

The collector remains pull-based; this envelope records the evidence a
controller needs before it changes a value. Missing fields are intentional:
an unavailable signal must not become a zero.

## Parameters

### series

`Record`\<`string`, `string` \| `number` \| `boolean` \| `null`\>

### options?

#### confidence?

`number`

Evidence confidence in `[0, 1]`.

#### fresh?

`boolean`

#### observedAt?

`number`

#### samples?

`number`

#### windowMs?

`number`

## Returns

`object`

### confidence

> **confidence**: `number`

### fresh

> **fresh**: `boolean`

### observedAt

> **observedAt**: `number`

### samples

> **samples**: `number`

### series

> **series**: `Record`\<`string`, `number` \| `boolean` \| `null` \| `string`\>

### version

> **version**: `number`

### windowMs

> **windowMs**: `number`
