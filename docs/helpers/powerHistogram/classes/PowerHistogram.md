[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerHistogram](../README.md) / PowerHistogram

# Class: PowerHistogram

Lock-free in-process histogram for latency telemetry and percentile estimation.

Use `PowerHistogram` to record latency values and query estimated
percentiles with a compact bucketed sketch.

 PowerHistogram

## Constructors

### Constructor

> **new PowerHistogram**(`options?`): `PowerHistogram`

#### Parameters

##### options?

###### bucketCount?

`number`

Number of buckets used internally.

###### maxValue?

`number`

Upper bound for the sketch range.

###### minValue?

`number`

Lower bound for the first non-zero bucket.

#### Returns

`PowerHistogram`

## Properties

### \_boundaries

> **\_boundaries**: `Float64Array`\<`ArrayBuffer`\> \| `undefined`

***

### \_bucketCount

> **\_bucketCount**: `number`

***

### \_buckets

> **\_buckets**: `Uint32Array`\<`ArrayBuffer`\>

***

### \_count

> **\_count**: `number`

***

### \_max

> **\_max**: `number`

***

### \_maxValue

> **\_maxValue**: `number`

***

### \_min

> **\_min**: `number`

***

### \_minValue

> **\_minValue**: `number`

***

### \_sum

> **\_sum**: `number`

## Accessors

### bucketCount

#### Get Signature

> **get** **bucketCount**(): `number`

Number of histogram buckets.

##### Returns

`number`

***

### count

#### Get Signature

> **get** **count**(): `number`

Number of records added.

##### Returns

`number`

***

### max

#### Get Signature

> **get** **max**(): `number` \| `undefined`

Maximum recorded value, or `undefined` when empty.

##### Returns

`number` \| `undefined`

***

### mean

#### Get Signature

> **get** **mean**(): `number`

Average of recorded values, or `0` when empty.

##### Returns

`number`

***

### min

#### Get Signature

> **get** **min**(): `number` \| `undefined`

Minimum recorded value, or `undefined` when empty.

##### Returns

`number` \| `undefined`

***

### sum

#### Get Signature

> **get** **sum**(): `number`

Sum of all recorded values.

##### Returns

`number`

## Methods

### \_bucketIndex()

> **\_bucketIndex**(`value`): `number`

#### Parameters

##### value

`any`

#### Returns

`number`

***

### \_buildBoundaries()

> **\_buildBoundaries**(): `void`

#### Returns

`void`

***

### \_estimateBucketValue()

> **\_estimateBucketValue**(`index`): `number`

#### Parameters

##### index

`any`

#### Returns

`number`

***

### percentile()

> **percentile**(`quantile`): `number` \| `undefined`

Return the estimated value for the requested percentile.

#### Parameters

##### quantile

`number`

Percentile between `0` and `100`, or fraction between `0` and `1`.

#### Returns

`number` \| `undefined`

Estimated percentile value, or `undefined` when empty.

***

### record()

> **record**(`value`): `PowerHistogram`

Record a numeric value into the histogram.

#### Parameters

##### value

`number`

Latency or measurement value.

#### Returns

`PowerHistogram`

***

### reset()

> **reset**(): `void`

Reset the histogram to an empty state.

#### Returns

`void`

***

### snapshot()

> **snapshot**(): `number`[]

Return a snapshot copy of bucket counts.

#### Returns

`number`[]
