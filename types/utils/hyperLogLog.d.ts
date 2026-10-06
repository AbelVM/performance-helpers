/**
 * HyperLogLog cardinality estimator.
 */
export class HyperLogLog {
    /** @type {Uint8Array} One byte per register. Ranks run 1..27, so a byte —
     *  not a nibble — is what this needs; the earlier "low nibble" comment was
     *  wrong and would have capped the estimator at 15 leading zeros. */
    registers: Uint8Array;
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
