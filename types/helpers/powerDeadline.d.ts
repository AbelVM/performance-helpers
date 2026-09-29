/**
 * @typedef {import('./jsdoc-types.js').PowerDeadlineOptions} PowerDeadlineOptions
 */
/**
 * Deadline-aware async helper for timeout, retry budget, and abort metadata.
 *
 * Use `PowerDeadline` to wrap async work with per-attempt timeouts, a total
 * deadline for the whole operation, and optional retry/backoff behavior.
 *
 * @class PowerDeadline
 * @public
 */
export class PowerDeadline {
    /**
     * Run a function with deadline semantics.
     * @param {Function} fn Async function to execute.
     * @param {PowerDeadlineOptions} [options]
     * @returns {Promise<any>}
     */
    static run(fn: Function, options?: PowerDeadlineOptions): Promise<any>;
    /**
     * Create a configured `PowerDeadline` instance.
     * @param {PowerDeadlineOptions} [options] Default options applied to every `run()` invocation.
     */
    constructor(options?: PowerDeadlineOptions);
    _options: import("./jsdoc-types.js").PowerDeadlineOptions;
    /**
     * Run a function with the configured deadline options merged with per-call options.
     * @param {Function} fn Async function to execute.
     * @param {PowerDeadlineOptions} [options]
     * @returns {Promise<any>}
     */
    run(fn: Function, options?: PowerDeadlineOptions): Promise<any>;
}
export default PowerDeadline;
export type PowerDeadlineOptions = import("./jsdoc-types.js").PowerDeadlineOptions;
