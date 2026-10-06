/**
 * HyperLogLog — probabilistic cardinality estimator.
 *
 * Uses 64 registers (b = 6). The standard error of a HyperLogLog sketch is
 * 1.04 / sqrt(m), so 64 registers give **~13 %**, not the ~1 % a reader
 * expects from that sentence — reaching 1 % needs ~11k registers (the 1.5 KB
 * the review budgeted for the companion admission filter). The footprint is
 * 64 bytes. Recorded here because the first draft of this header claimed 1 %
 * and would have sent the next reader down a wrong path.
 *
 * The implementation follows the standard Flajolet–Martin / HyperLogLog
 * algorithm:
 *   1. Hash the element to a 32-bit value.
 *   2. Use the first 6 bits to select a register.
 *   3. Count leading zeros in the remaining 26 bits.
 *   4. Store the maximum leading-zero count per register.
 *   5. Estimate cardinality from the harmonic mean of 2^M_i.
 *
 * @module
 */

/** Number of registers. Must be a power of two. */
const REGISTER_COUNT = 64;
/** Bits used for bucket selection. */
const REGISTER_BITS = 6;
/** Mask for bucket selection. */
const MASK = REGISTER_COUNT - 1;
/** Bias-correction constant for 64 registers. */
const ALPHA = 0.673;
/** Maximum rank: 26 leading zeros in the 26-bit remainder + 1. */
const MAX_RANK = 27;

/**
 * 32-bit finaliser. Applied to whatever `addHash` receives so the estimator is
 * robust to **unhashed** inputs — sequential integers 0..N all have
 * `h >>> REGISTER_BITS === 0`, which without a mix puts rank 27 in every
 * register and reports a cardinality in the billions for a 100-element set.
 *
 * This is the SplitMix64 finaliser avalanche, the same shape as
 * `mix32` in `smallLfu.js`. It is applied inside `addHash` rather than at the
 * call site because the promise of this class is that it estimates
 * cardinality; "pass me a hash" is an implementation detail that should not
 * be load-bearing. `SmallLfuSketch` already hashes with FNV-1a before calling
 * this, so the double mix is redundant there and costs nothing (it is only
 * invoked at sketch-reset time, once per `sampleSize` increments).
 *
 * @param {number} h
 * @returns {number} A well-distributed 32-bit value.
 * @private
 */
function finalise(h) {
  h = (h + 0x9e3779b1) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * HyperLogLog cardinality estimator.
 */
export class HyperLogLog {
  /** @type {Uint8Array} One byte per register. Ranks run 1..27, so a byte —
   *  not a nibble — is what this needs; the earlier "low nibble" comment was
   *  wrong and would have capped the estimator at 15 leading zeros. */
  registers;

  constructor() {
    this.registers = new Uint8Array(REGISTER_COUNT);
  }

  /**
   * Add an element to the estimator. The argument may be a raw value: it is
   * finalised internally, so `addHash(0)`, `addHash(1)` ... estimate correctly
   * rather than saturating.
   * @param {*} hash - A 32-bit hash value, or any value coercible to one.
   * @returns {void}
   */
  addHash(hash) {
    const h = finalise(hash | 0);
    const bucket = h & MASK;
    // Count leading zeros in the remaining 26 bits, then add 1 to get the
    // rank (position of the first 1 bit, 1-based). The rank is what the
    // harmonic mean in `cardinality()` expects.
    const bits = h >>> REGISTER_BITS;
    const rank = bits === 0 ? MAX_RANK : Math.min(MAX_RANK - 1, Math.clz32(bits) - 5);
    const current = this.registers[bucket];
    if (rank > current) {
      this.registers[bucket] = rank;
    }
  }

  /**
   * Estimate the number of distinct elements added.
   * @returns {number} Cardinality estimate.
   */
  cardinality() {
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < REGISTER_COUNT; i++) {
      const m = this.registers[i];
      sum += Math.pow(2, -m);
      if (m === 0) zeros += 1;
    }
    // Empty sketch: every register is zero.
    if (zeros === REGISTER_COUNT) return 0;
    // Small range correction: when many registers are zero the raw estimate
    // is too low. Linear counting over m buckets with Z empty ones estimates
    // the cardinality as m * ln(m / Z) — not Z * ln(m / Z), which is what the
    // first draft of this file wrote and which reported 21 for a 100-element
    // set. The threshold is derived from the standard HLL paper.
    if (zeros > 0) {
      const raw = (ALPHA * REGISTER_COUNT * REGISTER_COUNT) / sum;
      if (raw <= REGISTER_COUNT * 2.5) {
        return Math.max(1, Math.round(REGISTER_COUNT * Math.log(REGISTER_COUNT / zeros)));
      }
      return Math.round(raw);
    }
    return Math.round((ALPHA * REGISTER_COUNT * REGISTER_COUNT) / sum);
  }

  /**
   * Reset all registers to zero.
   * @returns {void}
   */
  reset() {
    this.registers.fill(0);
  }
}
