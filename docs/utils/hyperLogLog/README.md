[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / utils/hyperLogLog

# utils/hyperLogLog

HyperLogLog — probabilistic cardinality estimator.

This implementation follows the **sparse + dense** shape of HLL++ (Heule,
Nunkesser, Hall 2013): for small cardinalities the sketch stores the
distinct hashed values exactly (sparse representation), which removes the
variance that dominates the HLL estimate at small `n`; once the number of
distinct values exceeds a threshold the sparse set is flushed into the
standard dense register array and the sketch switches to the usual
Flajolet–Martin / HyperLogLog harmonic-mean estimate.

The dense phase keeps the existing behaviour (linear counting for small
ranges, bias constant per register count, internal finalisation of raw
inputs). The empirical bias-correction table that HLL++ applies to the
*raw* estimate in the mid range is **not** shipped: it is a measured
artefact (one table per precision `p`) and embedding an unmeasured
approximation would be worse than the linear-counting fallback already in
place. `bench/claims.js cardinality` is the gate for adding it.

6-bit packed registers (the memory half of HLL++) are also deferred: the
public `registers` property is a `Uint8Array` (one byte per register) so
that `registers.length === registerCount` and `registers.every(...)` keep
working for existing callers and tests. Packing would change that contract.

## Classes

- [HyperLogLog](classes/HyperLogLog.md)
