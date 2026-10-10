[**performance-helpers**](../../../README.md)

***

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

***

### \_belowRangeCount

> **\_belowRangeCount**: `number`

***

### \_buckets

> **\_buckets**: `Map`\<`number`, `number`\>

***

### \_count

> **\_count**: `number`

***

### \_gamma

> **\_gamma**: `number`

***

### \_infCount

> **\_infCount**: `number`

***

### \_legacyBucketCount

> **\_legacyBucketCount**: `number` \| `null`

***

### \_logGamma

> **\_logGamma**: `number`

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

### \_order

> **\_order**: \{ `indices`: `number`[]; `prefix`: `number`[]; \} \| `null`

***

### \_outOfRangeCount

> **\_outOfRangeCount**: `number`

***

### \_sum

> **\_sum**: `number`

***

### \_sumCompensation

> **\_sumCompensation**: `number`

***

### \_zeroCount

> **\_zeroCount**: `number`

## Accessors

### belowRangeCount

#### Get Signature

> **get** **belowRangeCount**(): `number`

Number of records below the advisory `minValue`.

##### Returns

`number`

***

### bucketCount

#### Get Signature

> **get** **bucketCount**(): `number`

Number of *occupied* buckets. The legacy option of the same name sized a
dense array; with sparse DDSketch storage this reports what is actually in
use, which is the useful number.

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

Average of the recorded values, or `0` when empty.

Averaged over the records that carry a value, not over `count`. A `+Infinity`
record is counted and reported in `infCount` but deliberately contributes
nothing to `sum`, so dividing `sum` by `count` under-reported every
histogram that saw one: `[10, Infinity]` gave `mean` of 5 for a single
finite sample. There is no finite mean over a set containing `Infinity`, so
the finite samples are averaged and the infinities are left to `infCount`.

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

### outOfRangeCount

#### Get Signature

> **get** **outOfRangeCount**(): `number`

Number of records that fell above the advisory `maxValue`. These are
stored faithfully - this counter exists so a caller can notice a range that
no longer matches reality instead of silently reading clamped data.

##### Returns

`number`

***

### relativeAccuracy

#### Get Signature

> **get** **relativeAccuracy**(): `number`

Configured relative error bound for quantiles.

##### Returns

`number`

***

### sum

#### Get Signature

> **get** **sum**(): `number`

Sum of all recorded values.

##### Returns

`number`

## Methods

### countAtOrBelow()

> **countAtOrBelow**(`value`): `number`

Estimated number of recorded samples whose value is **at or below**
`value` — the inverse of [PowerHistogram#percentile](#percentile), which maps a
rank to a value where this maps a value to a rank.

The name is deliberately not `countBelow`. `belowRangeCount` already means
*strictly* below in this class, and a method whose name says one thing
while its boundary does another is how an off-by-one reaches an SLO. The
boundary here is inclusive, which is the class APDEX calls "satisfied".

## What the estimate rests on

Every occupied bucket below the one `value` falls into is counted in full,
because such a bucket's entire multiplicative range lies at or below
`value`. The boundary bucket is **interpolated**: the share of its
log-range at or below `value` is applied to its count, which is the same
uniform-in-log-space assumption the bucket layout already makes. The error
is therefore bounded by the mass sitting in that one bucket, and it is
worst exactly where a distribution concentrates near the threshold — the
case `bench/claims.js apdex` measures rather than asserts.

A `+Infinity` record is never at or below a finite `value`, so it is
excluded; `countAtOrBelow(Infinity)` returns `count`.

#### Parameters

##### value

`number`

Threshold. `NaN` throws. A negative threshold
  returns `0`, because `record()` refuses negative values so nothing
  recorded can be at or below one. `0` returns the count of exact-zero
  records.

#### Returns

`number`

Estimated count in `[0, count]`. **Not an integer** when
  the boundary bucket is interpolated — rounding it would bias every
  threshold that lands mid-bucket in the same direction, and a caller who
  needs a whole number is one `Math.round()` from one.

***

### merge()

> **merge**(`other`): `PowerHistogram`

Merge another sketch into this one.

DDSketch buckets are exact multiplicative ranges, so the merge is exact
up to the same relative bound - unlike rank-error sketches (t-digest,
GK, KLL) which are only one-way mergeable. This is what makes it safe to
keep a per-worker histogram and fold them into a pool-level one.

**Accepts a plain sketch as well as a `PowerHistogram`** (AUD-012). A sketch
that crossed a worker boundary arrives as a plain object, because
`structuredClone` does not preserve the class, and rejecting it made the
distributed path this docblock advertises unreachable. The check is
structural rather than `instanceof` for the same reason — see
[PowerHistogram.fromJSON](#fromjson).

#### Parameters

##### other

`object` \| `PowerHistogram`

Sketch to absorb, either an instance
  or a `toJSON()` result. Must use the same `relativeAccuracy`; a mismatch
  is a configuration error because the bucket indices are not comparable.

#### Returns

`PowerHistogram`

***

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

  A value **above 100 saturates to the maximum** rather than throwing.
  That is deliberate and is the one place this method degrades instead of
  rejecting: `NaN` and a negative both throw, because they would index
  nonsense, whereas `150` asks for "at or above the top" and the maximum is
  the correct answer to that. Pinned by
  `test/powerHistogram.quantileRange.test.js`.

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

Latency or measurement value. Must be finite and
  non-negative.

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

Return a snapshot copy of bucket counts, ordered from the lowest occupied
bucket to the highest.

The array spans only the *occupied* range, so its length is
`bucketCount`-1 at most; a single leading entry is the zero bucket.

#### Returns

`number`[]

***

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

***

### fromJSON()

> `static` **fromJSON**(`obj`): `PowerHistogram`

Rebuild a sketch from its [PowerHistogram#toJSON](#tojson) representation.

**This is the missing half of the documented distributed path.** The class
doc advertises that the sketch "merges exactly, so per-worker or per-shard
sketches can be combined into a global histogram", and `toJSON()` has always
existed — but `structuredClone` does not preserve the class, so a sketch
arriving from a worker is a *plain object*, and `merge()` rejected it with
"expects a PowerHistogram". The headline use case was unreachable, and a
caller had to hand-roll reconstruction, which is exactly the kind of thing
that gets the bucket indices wrong.

Accepts the output of `toJSON()` and nothing else: a plain object with the
same shape. The check is **structural**, not `instanceof`, per the
cross-realm rule — `instanceof` is false for a value from another realm, and
this method exists precisely to consume values that crossed a boundary.

#### Parameters

##### obj

`object`

A `toJSON()` result. `relativeAccuracy` must match the
  sketch it will be merged into, because bucket indices are only comparable
  within the same accuracy.

#### Returns

`PowerHistogram`

A new sketch; `obj` is not retained.
