/**
 * PowerChunking helper
 *
 * Heuristically chunk an iterable and run `fn` for every item inside worker-like
 * inline workers managed by a `PowerPool`. Returns the result of
 * `PowerPool.postMessageBatch(...)` for the created chunked tasks.
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
 * @param {'light'|'medium'|'heavy'} [options.fnComplexity] - Hint about `fn` complexity to bias chunking. When omitted the helper
 *   will attempt to analyze `fn`'s source to infer a complexity score ('light'|'medium'|'heavy') and use that
 *   to bias the chunk size. If analysis fails the helper falls back to 'medium'.
 * @returns {PowerPool} The created `PowerPool` instance managing the chunked work.
 *   The helper enqueues chunk tasks internally (via `pool.postMessageBatch`).
 *   Listen to `pool.onmessage` to collect per-chunk results and call
 *   `await pool.drain()` to wait until all work is finished.
 *
 * Each `message` event `data` includes:
 * - `processed`: number of items processed in the chunk
 * - `results`: array of per-item return values (or error objects)
 * - `correlationId`: mirrored when provided
 *
 * Error object shape:
 * ```js
 * { error: true, code: string, message?: string, stack?: string }
 * ```
 */
export function PowerChunking(iterable: Iterable<any>, fn: Function, options?: Object | undefined): PowerPool;
import { PowerPool } from './powerPool.js';
