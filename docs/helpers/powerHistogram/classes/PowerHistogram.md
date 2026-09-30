[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/powerHistogram](../README.md) / PowerHistogram

# Class: PowerHistogram

## Constructors

### Constructor

> **new PowerHistogram**(`options?`): `PowerHistogram`

#### Parameters

##### options?

`PowerHistogramOptions` = `{}`

#### Returns

`PowerHistogram`

## Properties

### \_alpha

> **\_alpha**: `number`

---

### \_belowRangeCount

> **\_belowRangeCount**: `number`

---

### \_buckets

> **\_buckets**: `Map`\<`number`, `number`\>

---

### \_count

> **\_count**: `number`

---

### \_gamma

> **\_gamma**: `number`

---

### \_infCount

> **\_infCount**: `number`

---

### \_legacyBucketCount

> **\_legacyBucketCount**: `number` \| `null`

---

### \_logGamma

> **\_logGamma**: `number`

---

### \_max

> **\_max**: `number`

---

### \_maxValue

> **\_maxValue**: `number`

---

### \_min

> **\_min**: `number`

---

### \_minValue

> **\_minValue**: `number`

---

### \_outOfRangeCount

> **\_outOfRangeCount**: `number`

---

### \_sortedIndices

> **\_sortedIndices**: `number`[] \| `null`

---

### \_sum

> **\_sum**: `number`

---

### \_zeroCount

> **\_zeroCount**: `number`

## Accessors

### belowRangeCount

#### Get Signature

> **get** **belowRangeCount**(): `number`

Number of records below the advisory `minValue`.

##### Returns

`number`

---

### bucketCount

#### Get Signature

> **get** **bucketCount**(): `number`

Number of _occupied_ buckets. The legacy option of the same name sized a
dense array; with sparse DDSketch storage this reports what is actually in
use, which is the useful number.

##### Returns

`number`

---

### count

#### Get Signature

> **get** **count**(): `number`

Number of records added.

##### Returns

`number`

---

### max

#### Get Signature

> **get** **max**(): `number` \| `undefined`

Maximum recorded value, or `undefined` when empty.

##### Returns

`number` \| `undefined`

---

### mean

#### Get Signature

> **get** **mean**(): `number`

Average of the recorded values, or `0` when empty.

Averaged over the records that carry a value, not over `count`. A `+Infinity`
record is counted and reported in `infCount` but deliberately contributes
nothing to `sum`, so dividing `sum` by `count` under-reported every
histogram that saw one: `[10, Infinity]` gave `mean` of 5 for a single
finite sample. There is no finite mean over a set containing `Infinity`, so
the finite samples are averaged and the infinities are left to `infCount`.

##### Returns

`number`

---

### min

#### Get Signature

> **get** **min**(): `number` \| `undefined`

Minimum recorded value, or `undefined` when empty.

##### Returns

`number` \| `undefined`

---

### outOfRangeCount

#### Get Signature

> **get** **outOfRangeCount**(): `number`

Number of records that fell above the advisory `maxValue`. These are
stored faithfully - this counter exists so a caller can notice a range that
no longer matches reality instead of silently reading clamped data.

##### Returns

`number`

---

### relativeAccuracy

#### Get Signature

> **get** **relativeAccuracy**(): `number`

Configured relative error bound for quantiles.

##### Returns

`number`

---

### sum

#### Get Signature

> **get** **sum**(): `number`

Sum of all recorded values.

##### Returns

`number`

## Methods

### merge()

> **merge**(`other`): `PowerHistogram`

Merge another sketch into this one.

DDSketch buckets are exact multiplicative ranges, so the merge is exact
up to the same relative bound - unlike rank-error sketches (t-digest,
GK, KLL) which are only one-way mergeable. This is what makes it safe to
keep a per-worker histogram and fold them into a pool-level one.

#### Parameters

##### other

`PowerHistogram`

Sketch to absorb. Must use the same
`relativeAccuracy`; a mismatch is a configuration error because the
bucket indices are not comparable.

#### Returns

`PowerHistogram`

---

### percentile()

> **percentile**(`quantile`): `number` \| `undefined`

Return the estimated value for the requested percentile.

The estimate is guaranteed to be within `relativeAccuracy` of the true
quantile, for any value range.

#### Parameters

##### quantile

`number`

Percentile between `0` and `100`, or fraction
between `0` and `1`. **The two ranges overlap at `1`, and the fraction
reading wins** — `percentile(1)` is the 100th percentile, not the 1st.
Use `0.5` or `50` for p50 and `100` for the maximum. This is documented
rather than accidental: see `guides/powerHistogram.md`, which calls `1`
"the one to watch".

#### Returns

`number` \| `undefined`

Estimated percentile value, or `undefined` when empty.

---

### record()

> **record**(`value`): `PowerHistogram`

Record a numeric value into the histogram.

#### Parameters

##### value

`number`

Latency or measurement value. Must be finite and
non-negative.

#### Returns

`PowerHistogram`

---

### reset()

> **reset**(): `void`

Reset the histogram to an empty state.

#### Returns

`void`

---

### snapshot()

> **snapshot**(): `number`[]

Return a snapshot copy of bucket counts, ordered from the lowest occupied
bucket to the highest.

The array spans only the _occupied_ range, so its length is
`bucketCount`-1 at most; a single leading entry is the zero bucket.

#### Returns

`number`[]

---

### toJSON()

> **toJSON**(): `object`

Serializable representation, suitable for merging elsewhere or shipping to
a metrics backend.

#### Returns

`object`

##### belowRangeCount

> **belowRangeCount**: `number`

##### buckets

> **buckets**: \[`number`, `number`\][]

##### count

> **count**: `number`

##### infCount

> **infCount**: `number`

##### max

> **max**: `number`

##### min

> **min**: `number`

##### outOfRangeCount

> **outOfRangeCount**: `number`

##### relativeAccuracy

> **relativeAccuracy**: `number`

##### sum

> **sum**: `number`

##### zeroCount

> **zeroCount**: `number`
