/**
 * @typedef {import('./jsdoc-types.js').PowerChunkingOptions} PowerChunkingOptions
 */
/**
 * PowerChunking helper (class `PowerChunker`)
 *
 * Construct with `new PowerChunker(iterable, fn, options)` to create a
 * helper that heuristically chunks an iterable and runs `fn` for every item
 * inside lightweight inline worker-like instances managed by a `PowerPool`.
 * The constructor returns the created `PowerPool` instance so callers can
 * interact with it (listen `onmessage`, call `drain()`, `terminate()`, etc.).
 *
 * Usage:
 * ```js
 * const pool = new PowerChunker(iterable, fn, options);
 * pool.onmessage = (e) => { // handle per-chunk results };
 * await pool.drain();
 * ```
 *
 * Notes:
 * - This helper creates lightweight inline worker-like instances that execute
 *   `fn(item, index, chunk)` on each chunk element asynchronously (via
 *   setTimeout) so tests and environments without real Worker support still work.
 * - For heavy CPU work prefer a real Worker source string and create your own
 *   `PowerPool` instead; this helper focuses on convenience and correctness.
 *
 * @param {Iterable<any>} iterable - Input iterable of items to process.
 * @param {Function} fn - Function to call for each item: `(item, index?, chunk?) => void`.
 * @param {Object=} options
 * @param {Object=} options.poolOptions - Options forwarded to `PowerPool` constructor.
 * @param {Object=} options.postOptions - Options forwarded to `postMessageBatch`.
 * @param {number=} options.chunkSize - Explicit chunk size to use. When omitted a heuristic is used.
 * @param {'light'|'medium'|'heavy'} [options.fnComplexity] - Hint about `fn` complexity to bias chunking.
 * @class PowerChunker
 * @public
 * @returns {PowerPool} The created `PowerPool` instance managing the chunked work.
 */
export class PowerChunker {
    constructor(iterable: any, fn: any, options?: {});
}
export type PowerChunkingOptions = import("./jsdoc-types.js").PowerChunkingOptions;
