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

/**
 * Default number of registers. Must be a power of two.
 *
 * 64 gives a theoretical relative error of `1.04/sqrt(64)` ≈ 13 %, which is
 * below the threshold at which approximate distinct counting is worth doing at
 * all — the estimator cannot distinguish 1,000 from 1,130. The constructor takes
 * a register count so a caller who needs better can pay for it in bytes; see
 * `bench/claims.js cardinality` for the measured accuracy/memory trade.
 */
const DEFAULT_REGISTER_COUNT = 64;
/**
 * The HLL bias-correction constant for a given register count.
 *
 * **This was a hardcoded `0.673`, which is the constant for m=16 — not for the
 * 64 registers the class shipped with.** The standard values are 0.673 at m=16,
 * 0.697 at 32, 0.709 at 64, and `0.7213 / (1 + 1.079/m)` from 128 up. Using the
 * m=16 value at m=64 biases every estimate low by roughly 5 %, which is the same
 * order as the error the sketch is supposed to bound — so the class was quoting a
 * 13 % relative error while carrying a 5 % bias on top of it.
 *
 * Found while parameterising the register count for `bench/claims.js cardinality`
 * (AUD-026): a constant that is wrong for the one configuration the class
 * hardcoded is invisible until the configuration becomes a parameter.
 *
 * @param {number} m - Register count.
 * @returns {number}
 */
function alphaFor(m) {
  if (m === 16) return 0.673;
  if (m === 32) return 0.697;
  if (m === 64) return 0.709;
  return 0.7213 / (1 + 1.079 / m);
}

/**
 * 32-bit finaliser. Applied to whatever `addHash` receives so the estimator is
 * robust to **unhashed** inputs — sequential integers 0..N all have
 * `h >>> log2(m) === 0`, which without a mix puts rank 27 in every
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

  /**
   * @param {number} [registerCount=64] - Number of registers. Must be a power of
   *   two. The relative error is `1.04/sqrt(m)`, so 256 registers give ~6.5 %
   *   and 1024 give ~3.2 %, at one byte per register.
   *
   *   **A parameter rather than a constant, because the shipped 64 is a
   *   deliberate trade rather than a limit.** The audit that raised this
   *   proposed replacing the sketch outright to reach a usable accuracy; raising
   *   the register count reaches most of the way there for bytes this library
   *   can afford, and `bench/claims.js cardinality` measures exactly how far.
   */
  constructor(registerCount = DEFAULT_REGISTER_COUNT) {
    // **Checked before any coercion.** `Math.floor` would turn 1.5 into 1, which
    // is a power of two, so a fractional count would be silently accepted as a
    // different one — the same "coerced everywhere, silently" shape RT-013
    // records for the reconnect bounds. The value is validated as given, then
    // used as given.
    const m = Number(registerCount);
    if (!Number.isInteger(m) || m < 1 || (m & (m - 1)) !== 0) {
      throw new TypeError(
        `HyperLogLog: registerCount must be a power of two, received ${String(registerCount)}`
      );
    }
    /** @type {number} */
    this.registerCount = m;
    /** @type {number} The bias constant for this register count. */
    this._alpha = alphaFor(m);
    /**
     * Bits consumed by the bucket index, and the widest rank the remainder can
     * produce. Both derived from the register count rather than hardcoded, so a
     * count other than 64 is calibrated rather than merely tolerated.
     * @type {number}
     */
    this._shift = Math.log2(m);
    /** @type {number} */
    this._maxRank = 32 - this._shift + 1;
    /** @type {Uint8Array} One byte per register. */
    this.registers = new Uint8Array(m);
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
    const bucket = h & (this.registerCount - 1);
    // The remaining bits after the bucket index. Their width is what the rank
    // calibration below is derived from, so it is computed rather than assumed:
    // the original code hardcoded a 26-bit remainder and a `- 5` offset, which
    // is correct for exactly one register count and silently wrong for any
    // other. Found by parameterising the count — m=1024 overestimated a
    // 100 000-element set by 15x until this was derived.
    const shift = this._shift;
    const bits = h >>> shift;
    // Leading zeros *within the remainder*, plus 1, is the 1-based position of
    // the first set bit — the rank the harmonic mean expects. `clz32` counts in
    // 32 bits, so the `shift` leading zeros the bucket consumed are subtracted
    // back out.
    const rank =
      bits === 0 ? this._maxRank : Math.min(this._maxRank - 1, Math.clz32(bits) - shift + 1);
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
    for (let i = 0; i < this.registerCount; i++) {
      const m = this.registers[i];
      sum += Math.pow(2, -m);
      if (m === 0) zeros += 1;
    }
    // Empty sketch: every register is zero.
    if (zeros === this.registerCount) return 0;
    // Small range correction: when many registers are zero the raw estimate
    // is too low. Linear counting over m buckets with Z empty ones estimates
    // the cardinality as m * ln(m / Z) — not Z * ln(m / Z), which is what the
    // first draft of this file wrote and which reported 21 for a 100-element
    // set. The threshold is derived from the standard HLL paper.
    if (zeros > 0) {
      const raw = (this._alpha * this.registerCount * this.registerCount) / sum;
      if (raw <= this.registerCount * 2.5) {
        return Math.max(1, Math.round(this.registerCount * Math.log(this.registerCount / zeros)));
      }
      return Math.round(raw);
    }
    return Math.round((this._alpha * this.registerCount * this.registerCount) / sum);
  }

  /**
   * Reset all registers to zero.
   * @returns {void}
   */
  reset() {
    this.registers.fill(0);
  }
}
