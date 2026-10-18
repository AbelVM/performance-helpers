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
*raw* estimate in the mid range was **measured and rejected**: a 500-trial
bias study (`bench/claims.js cardinality` is the gate) showed the empirical
tables are noisy and over-correct in the transition region (e.g. m=1024,
n=10k: -24 % over-correction), so they do not improve the error constant
and are not shipped. The linear-counting fallback already in place is
preferred.

6-bit packed registers (the memory half of HLL++) are also rejected: the
public `registers` property is a `Uint8Array` (one byte per register) so
that `registers.length === registerCount` and `registers.every(...)` keep
working for existing callers and tests. Packing would change that contract
for a 25 % memory saving a caller can equivalently obtain by choosing a
smaller register count.

## Classes

- [HyperLogLog](classes/HyperLogLog.md)
