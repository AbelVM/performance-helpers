[**performance-helpers**](../../../README.md)

---

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

---

### depth

> **depth**: `number`

---

### mask

> **mask**: `number`

---

### resets

> **resets**: `number`

---

### sample

> **sample**: `number`

---

### sampleSize

> **sampleSize**: `number`

---

### seed

> **seed**: `number`

---

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

---

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

---

### increment()

> **increment**(`key`): `void`

Record one occurrence of `key` and, periodically, age the whole sketch.

The sample counter advances only when an increment was **effective** — when
at least one row's counter actually moved. Caffeine does the same
(`incrementAt` returns false once a counter is saturated, and only an
effective increment advances `size`). Advancing it unconditionally meant
that a fully saturated sketch reset on schedule anyway, so the half-life
was measured in _operations_ rather than in _changes to the estimates_:
every increment after saturation was a no-op on the data and a full
countdown on the clock, and the sketch halved far more often than
`sampleSize` describes.

#### Parameters

##### key

`any`

#### Returns

`void`

---

### reset()

> **reset**(): `void`

The half-life reset: halve every counter, dropping the odd ones.

`>> 1` on a nibble is floor division by two, so a counter of 1 becomes 0
and 2 becomes 1. That rounding _down_ is deliberate - it is what gives the
window its exponential decay, and it biases towards forgetting rather than
remembering, which is the right direction for an admission filter.

#### Returns

`void`

---

### size()

> **size**(): `number`

The sketch's footprint in bytes. Exposed so a caller can reason about the
memory an admission filter costs.

#### Returns

`number`
