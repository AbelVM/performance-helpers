/**
 * A 4-bit Count-Min Sketch with a half-life reset.
 */
export class SmallLfuSketch {
    /**
     * @param {Object} [options]
     * @param {number} [options.width=64] Columns per row, rounded up to a power
     *   of two. The sketch's memory is `width * depth / 2` bytes.
     * @param {number} [options.depth=4] Hash rows. More rows cost memory and buy
     *   accuracy; four is the usual choice and is what the reference
     *   implementations use.
     * @param {number} [options.sampleSize=10] `size()` increments between
     *   half-life resets.
     * @param {number} [options.seed] Per-cache seed, so two caches do not share a
     *   hash pattern. Random when omitted.
     */
    constructor({ width, depth, sampleSize, seed, }?: {
        width?: number | undefined;
        depth?: number | undefined;
        sampleSize?: number | undefined;
        seed?: number | undefined;
    });
    width: number;
    depth: number;
    mask: number;
    sampleSize: number;
    counters: Uint8Array<ArrayBuffer>;
    sample: number;
    resets: number;
    seed: number;
    /**
     * The sketch's footprint in bytes. Exposed so a caller can reason about the
     * memory an admission filter costs.
     * @returns {number}
     */
    size(): number;
    /**
     * Column index for `key` in row `row`.
     * @param {*} key
     * @param {number} row
     * @returns {number}
     * @private
     */
    private _index;
    /**
     * Read one 4-bit counter.
     * @param {number} index - Flat counter index.
     * @returns {number} 0..15.
     * @private
     */
    private _get;
    /**
     * Write one 4-bit counter, saturating at 15.
     * @param {number} index
     * @param {number} value
     * @returns {void}
     * @private
     */
    private _set;
    /**
     * Record one occurrence of `key` and, periodically, age the whole sketch.
     * @param {*} key
     * @returns {void}
     */
    increment(key: any): void;
    /**
     * Estimated frequency of `key`: the minimum across rows, which is what makes
     * this Count-Min rather than plain counting. Overcounting is the only error
     * mode, and the safe one - a key can look slightly hotter than it is, never
     * colder.
     * @param {*} key
     * @returns {number} 0..15.
     */
    estimate(key: any): number;
    /**
     * The half-life reset: halve every counter, dropping the odd ones.
     *
     * `>> 1` on a nibble is floor division by two, so a counter of 1 becomes 0
     * and 2 becomes 1. That rounding *down* is deliberate - it is what gives the
     * window its exponential decay, and it biases towards forgetting rather than
     * remembering, which is the right direction for an admission filter.
     * @returns {void}
     */
    reset(): void;
    /**
     * Clear every counter. Used by `PowerCache.reset()` - a reset cache has no
     * frequency history, and carrying one across would bias the next admission
     * decisions toward a workload that no longer exists.
     * @returns {void}
     */
    clear(): void;
}
export default SmallLfuSketch;
