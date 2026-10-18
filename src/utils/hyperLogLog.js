/**
 * HyperLogLog — probabilistic cardinality estimator.
 *
 * This implementation follows the **sparse + dense** shape of HLL++ (Heule,
 * Nunkesser, Hall 2013): for small cardinalities the sketch stores the
 * distinct hashed values exactly (sparse representation), which removes the
 * variance that dominates the HLL estimate at small `n`; once the number of
 * distinct values exceeds a threshold the sparse set is flushed into the
 * standard dense register array and the sketch switches to the usual
 * Flajolet–Martin / HyperLogLog harmonic-mean estimate.
 *
 * The dense phase keeps the existing behaviour (linear counting for small
 * ranges, bias constant per register count, internal finalisation of raw
 * inputs). The empirical bias-correction table that HLL++ applies to the
 * *raw* estimate in the mid range was **measured and rejected**: a 500-trial
 * bias study (`bench/claims.js cardinality` is the gate) showed the empirical
 * tables are noisy and over-correct in the transition region (e.g. m=1024,
 * n=10k: -24 % over-correction), so they do not improve the error constant
 * and are not shipped. The linear-counting fallback already in place is
 * preferred.
 *
 * 6-bit packed registers (the memory half of HLL++) are also rejected: the
 * public `registers` property is a `Uint8Array` (one byte per register) so
 * that `registers.length === registerCount` and `registers.every(...)` keep
 * working for existing callers and tests. Packing would change that contract
 * for a 25 % memory saving a caller can equivalently obtain by choosing a
 * smaller register count.
 *
 * @module
 */

/**
 * Default number of registers. Must be a power of two.
 */
const DEFAULT_REGISTER_COUNT = 64;

/** @param {number} m */
function alphaFor(m) {
  if (m === 16) return 0.673;
  if (m === 32) return 0.697;
  if (m === 64) return 0.709;
  return 0.7213 / (1 + 1.079 / m);
}

/** Count leading zeros of a 32-bit unsigned integer, with a fallback for
 * runtimes without `Math.clz32` (B2-020).
 * @param {number} x */
function clz32(x) {
  if (typeof Math.clz32 === 'function') return Math.clz32(x);
  x = x >>> 0;
  if (x === 0) return 32;
  let n = 0;
  if ((x & 0xffff0000) === 0) {
    n += 16;
    x <<= 16;
  }
  if ((x & 0xff000000) === 0) {
    n += 8;
    x <<= 8;
  }
  if ((x & 0xf0000000) === 0) {
    n += 4;
    x <<= 4;
  }
  if ((x & 0xc0000000) === 0) {
    n += 2;
    x <<= 2;
  }
  if ((x & 0x80000000) === 0) {
    n += 1;
  }
  return n;
}

/** @param {number} h */
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
  /** @type {Uint8Array} One byte per register (dense phase). */
  registers;

  /**
   * @param {number} [registerCount=64] - Number of registers. Must be a power of
   *   two.
   * @param {Object} [options]
   * @param {boolean} [options.sparse=true] - Enable sparse representation for
   *   small cardinalities (exact counting until the threshold is reached).
   * @param {number} [options.sparseThreshold] - Distinct-count threshold at
   *   which the sketch converts from sparse to dense. Defaults to
   *   `registerCount * 4`.
   */
  constructor(registerCount = DEFAULT_REGISTER_COUNT, options = {}) {
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
    this._shift = Math.log2(m);
    this._maxRank = 32 - this._shift + 1;

    /** @type {Uint8Array} One byte per register. */
    this.registers = new Uint8Array(m);

    const opts = options && typeof options === 'object' ? options : {};
    this._sparseEnabled = opts.sparse !== false;
    const rawThreshold = opts.sparseThreshold;
    this._sparseThreshold =
      Number.isFinite(rawThreshold) && /** @type {number} */ (rawThreshold) > 0
        ? Math.floor(/** @type {number} */ (rawThreshold))
        : m * 4;

    /** @type {Set<number>|null} Distinct finalised hashes in sparse phase. */
    this._sparseSet = this._sparseEnabled ? new Set() : null;
    /** @type {boolean} Whether the sketch has converted to dense. */
    this._dense = !this._sparseEnabled;
  }

  /**
   * Add an element to the estimator.
   * @param {*} hash
   * @returns {void}
   */
  addHash(hash) {
    const h = finalise(hash | 0);

    // Sparse phase: store distinct hashes exactly.
    if (!this._dense && this._sparseSet) {
      this._sparseSet.add(h);
      if (this._sparseSet.size > this._sparseThreshold) {
        this._convertToDense();
      }
      return;
    }

    // Dense phase: standard HLL register update.
    const bucket = h & (this.registerCount - 1);
    const shift = this._shift;
    const bits = h >>> shift;
    const rank = bits === 0 ? this._maxRank : Math.min(this._maxRank - 1, clz32(bits) - shift + 1);
    const current = this.registers[bucket];
    if (rank > current) {
      this.registers[bucket] = rank;
    }
  }

  /**
   * Convert the sparse set into dense registers.
   * @private
   * @returns {void}
   */
  _convertToDense() {
    if (this._dense) return;
    this._dense = true;
    if (!this._sparseSet) return;
    for (const h of this._sparseSet) {
      const bucket = h & (this.registerCount - 1);
      const shift = this._shift;
      const bits = h >>> shift;
      const rank =
        bits === 0 ? this._maxRank : Math.min(this._maxRank - 1, clz32(bits) - shift + 1);
      const current = this.registers[bucket];
      if (rank > current) {
        this.registers[bucket] = rank;
      }
    }
    this._sparseSet = null;
  }

  /**
   * Estimate the number of distinct elements added.
   * @returns {number}
   */
  cardinality() {
    // Sparse phase: exact distinct count.
    if (!this._dense && this._sparseSet) {
      return this._sparseSet.size;
    }

    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < this.registerCount; i++) {
      const m = this.registers[i];
      sum += Math.pow(2, -m);
      if (m === 0) zeros += 1;
    }
    if (zeros === this.registerCount) return 0;
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
   * Reset all registers to zero and return to sparse phase.
   * @returns {void}
   */
  reset() {
    this.registers.fill(0);
    if (this._sparseEnabled) {
      this._sparseSet = new Set();
      this._dense = false;
    }
  }

  /**
   * Whether the sketch is currently in dense mode.
   * @returns {boolean}
   */
  get isDense() {
    return this._dense;
  }
}
