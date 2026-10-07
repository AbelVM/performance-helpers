[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/metrics](../README.md) / diffObservation

# Function: diffObservation()

> **diffObservation**(`current`, `previous?`): `Record`\<`string`, `number` \| `null`\>

Calculate numeric changes between two observations.

A missing or non-numeric pair is reported as `null`, rather than coerced to
zero. That keeps a controller from treating a newly-added or unavailable
signal as evidence of a drop.

## Parameters

### current

#### series

`Record`\<`string`, `number` \| `boolean` \| `null` \| `string`\>

### previous?

#### series

`Record`\<`string`, `number` \| `boolean` \| `null` \| `string`\>

## Returns

`Record`\<`string`, `number` \| `null`\>
