[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerHistogram](../README.md) / isPowerHistogram

# Function: isPowerHistogram()

> **isPowerHistogram**(`v`): `v is PowerHistogram`

Realm-independent check for a `PowerHistogram` *instance* (as opposed to a
JSON sketch). Used instead of `instanceof PowerHistogram`, which compares
against this realm's prototype and silently rejects a histogram from another
`vm` context, iframe or worker (B2-001/B2-002).

The check is structural on the instance's private fields, which is the same
shape `isHistogramSketch`'s instance branch tests — so a cross-realm
instance is accepted and a plain object sketch is not.

## Parameters

### v

`unknown`

## Returns

`v is PowerHistogram`
