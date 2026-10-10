/**
 * HyperLogLog cardinality estimator.
 */
export class HyperLogLog {
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
    constructor(registerCount?: number);
    /** @type {Uint8Array} One byte per register. Ranks run 1..27, so a byte —
     *  not a nibble — is what this needs; the earlier "low nibble" comment was
     *  wrong and would have capped the estimator at 15 leading zeros. */
    registers: Uint8Array;
    /** @type {number} */
    registerCount: number;
    /** @type {number} The bias constant for this register count. */
    _alpha: number;
    /**
     * Bits consumed by the bucket index, and the widest rank the remainder can
     * produce. Both derived from the register count rather than hardcoded, so a
     * count other than 64 is calibrated rather than merely tolerated.
     * @type {number}
     */
    _shift: number;
    /** @type {number} */
    _maxRank: number;
    /**
     * Add an element to the estimator. The argument may be a raw value: it is
     * finalised internally, so `addHash(0)`, `addHash(1)` ... estimate correctly
     * rather than saturating.
     * @param {*} hash - A 32-bit hash value, or any value coercible to one.
     * @returns {void}
     */
    addHash(hash: any): void;
    /**
     * Estimate the number of distinct elements added.
     * @returns {number} Cardinality estimate.
     */
    cardinality(): number;
    /**
     * Reset all registers to zero.
     * @returns {void}
     */
    reset(): void;
}
