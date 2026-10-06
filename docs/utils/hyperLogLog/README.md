[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / utils/hyperLogLog

# utils/hyperLogLog

HyperLogLog — probabilistic cardinality estimator.

Uses 64 registers (b = 6). The standard error of a HyperLogLog sketch is
1.04 / sqrt(m), so 64 registers give **~13 %**, not the ~1 % a reader
expects from that sentence — reaching 1 % needs ~11k registers (the 1.5 KB
the review budgeted for the companion admission filter). The footprint is
64 bytes. Recorded here because the first draft of this header claimed 1 %
and would have sent the next reader down a wrong path.

The implementation follows the standard Flajolet–Martin / HyperLogLog
algorithm:
  1. Hash the element to a 32-bit value.
  2. Use the first 6 bits to select a register.
  3. Count leading zeros in the remaining 26 bits.
  4. Store the maximum leading-zero count per register.
  5. Estimate cardinality from the harmonic mean of 2^M_i.

## Classes

- [HyperLogLog](classes/HyperLogLog.md)
