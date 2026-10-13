[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/smallLfu](../README.md) / SmallLfuSketch

# Class: SmallLfuSketch

A 4-bit Count-Min Sketch with a half-life reset.

## Constructors

### Constructor

> **new SmallLfuSketch**(`options?`): `SmallLfuSketch`

#### Parameters

##### options?

###### depth?

`number` = `DEFAULT_DEPTH`

Hash rows. More rows cost memory and buy
  accuracy; four is the usual choice and is what the reference
  implementations use.

###### sampleSize?

`number` = `DEFAULT_SAMPLE_SIZE`

`size()` increments between
  half-life resets.

###### seed?

`number`

Per-cache seed, so two caches do not share a
  hash pattern. Random when omitted.

###### width?

`number` = `DEFAULT_WIDTH`

Columns per row, rounded up to a power
  of two. The sketch's memory is `width * depth / 2` bytes.

#### Returns

`SmallLfuSketch`

## Properties

### counters

> **counters**: `Uint8Array`\<`ArrayBuffer`\>

***

### depth

> **depth**: `number`

***

### mask

> **mask**: `number`

***

### resets

> **resets**: `number`

***

### sample

> **sample**: `number`

***

### sampleSize

> **sampleSize**: `number`

***

### seed

> **seed**: `number`

***

### width

> **width**: `number`

## Methods

### clear()

> **clear**(): `void`

Clear every counter. Used by `PowerCache.reset()` - a reset cache has no
frequency history, and carrying one across would bias the next admission
decisions toward a workload that no longer exists.

#### Returns

`void`

***

### estimate()

> **estimate**(`key`): `number`

Estimated frequency of `key`: the minimum across rows, which is what makes
this Count-Min rather than plain counting. Overcounting is the only error
mode, and the safe one - a key can look slightly hotter than it is, never
colder.

#### Parameters

##### key

`any`

#### Returns

`number`

0..15.

***

### increment()

> **increment**(`key`): `void`

Record one occurrence of `key` and, periodically, age the whole sketch.

**The half-life is measured in operations, not in changes to the
estimates.** This used to advance `sample` only when an increment was
*effective* — when at least one row's counter actually moved — on the
reasoning that a saturated sketch should not reset "with no change to
anything a reader could observe". Caffeine advances only on an effective
increment too (`incrementAt` returns false once a counter is saturated), so
the reasoning had a precedent behind it.

The consequence is that a fully saturated sketch **never resets at all**,
and a sketch that never resets can never forget. Halving is the only thing
that lets a counter fall below the 4-bit maximum of 15, and
`PowerCache`'s admission rule refuses on
`estimate(incumbent) >= estimate(challenger)` — so a counter pinned at 15
is unbeatable by construction, and a working set that has been retired
holds the cache forever. Measured before the fix: a 200-entry cache warmed
on one working set for 20 000 requests and then worked on a disjoint set
for 60 000 reached `rejectedAdmission` 60 000, `evictions` 0, and a hit
rate falling from 99 % to 24.8 % with no recovery. Plain LRU on the same
trace recovers to 99 % immediately.

Time passing is not the same as the data changing, and a decay mechanism
that stops when the data stops changing is not a decay mechanism. The
"resets far more often than `sampleSize` describes" complaint was about the
*rate*; the fix for a rate is `sampleSize`, which ALG-005 already auto-tunes
from the observed cardinality — and which could not fire while the clock
was frozen, so the auto-tune was dead in exactly the case it was needed.

#### Parameters

##### key

`any`

#### Returns

`void`

***

### reset()

> **reset**(): `void`

The half-life reset: halve every counter, dropping the odd ones.

`>> 1` on a nibble is floor division by two, so a counter of 1 becomes 0
and 2 becomes 1. That rounding *down* is deliberate - it is what gives the
window its exponential decay, and it biases towards forgetting rather than
remembering, which is the right direction for an admission filter.

#### Returns

`void`

***

### size()

> **size**(): `number`

The sketch's footprint in bytes. Exposed so a caller can reason about the
memory an admission filter costs.

#### Returns

`number`
