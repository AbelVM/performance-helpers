/**
 * HyperLogLog cardinality estimator.
 */
export class HyperLogLog {
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
    constructor(registerCount?: number, options?: {
        sparse?: boolean | undefined;
        sparseThreshold?: number | undefined;
    });
    /** @type {Uint8Array} One byte per register (dense phase). */
    registers: Uint8Array;
    /** @type {number} */
    registerCount: number;
    /** @type {number} The bias constant for this register count. */
    _alpha: number;
    _shift: number;
    _maxRank: number;
    _sparseEnabled: boolean;
    _sparseThreshold: number;
    /** @type {Set<number>|null} Distinct finalised hashes in sparse phase. */
    _sparseSet: Set<number> | null;
    /** @type {boolean} Whether the sketch has converted to dense. */
    _dense: boolean;
    /**
     * Add an element to the estimator.
     * @param {*} hash
     * @returns {void}
     */
    addHash(hash: any): void;
    /**
     * Convert the sparse set into dense registers.
     * @private
     * @returns {void}
     */
    private _convertToDense;
    /**
     * Estimate the number of distinct elements added.
     * @returns {number}
     */
    cardinality(): number;
    /**
     * Reset all registers to zero and return to sparse phase.
     * @returns {void}
     */
    reset(): void;
    /**
     * Whether the sketch is currently in dense mode.
     * @returns {boolean}
     */
    get isDense(): boolean;
}
