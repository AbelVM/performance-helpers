import { PowerPool } from './powerPool.js';
import { u82o } from './powerBuffer.js';
import { normalizeError } from '../utils/errors.js';

/**
 * @typedef {Object} PowerChunkingOptions
 * @property {Object} [poolOptions]
 * @property {Object} [postOptions]
 * @property {number} [chunkSize]
 * @property {'light'|'medium'|'heavy'} [fnComplexity]
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
 * @param {'light'|'medium'|'heavy'} [options.fnComplexity] - Hint about `fn` complexity to bias chunking. When omitted the helper
 *   will attempt to analyze `fn`'s source to infer a complexity score ('light'|'medium'|'heavy') and use that
 *   to bias the chunk size. If analysis fails the helper falls back to 'medium'.
 * @returns {PowerPool} The created `PowerPool` instance managing the chunked work.
 *   The constructor returns the `PowerPool` instance; the helper enqueues
 *   chunk tasks internally (via `pool.postMessageBatch`). Listen to
 *   `pool.onmessage` to collect per-chunk results and call `await pool.drain()`
 *   to wait until all work is finished.
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
export class PowerChunker {
  constructor(iterable, fn, options = {}) {
    if (!iterable || typeof fn !== 'function') {
      throw new Error('PowerChunker requires an iterable and a function');
    }

    const {
      poolOptions = {},
      postOptions = {},
      chunkSize: explicitChunkSize,
      fnComplexity: providedFnComplexity,
    } = options;

    // Detect if we can eagerly measure total size. For arrays we can compute
    // an exact chunking strategy; for generic iterables we stream chunks to
    // avoid materializing the entire iterable into memory.
    const isArray = Array.isArray(iterable);
    const items = isArray ? iterable : null;
    const total = isArray ? items.length : null;

    const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
    const poolSize =
      poolOptions && Number.isFinite(poolOptions.size) && poolOptions.size > 0
        ? poolOptions.size
        : Math.max(1, hw);

    // Analyze `fn` to estimate complexity when the caller did not provide `fnComplexity`.
    function analyzeFnComplexity(fnToAnalyze) {
      // Avoid relying on fragile `fn.toString()` heuristics which can be
      // incorrect for minified/transpiled code or functions that close over
      // user data. Use safer, low-cost signals instead:
      // - Async/generator functions are likely heavier (IO or streaming).
      // - Functions declaring many parameters often accept callbacks/context.
      // - Default to 'medium' when unsure.
      try {
        const ctorName = fnToAnalyze && fnToAnalyze.constructor && fnToAnalyze.constructor.name;
        if (ctorName === 'AsyncFunction' || ctorName === 'GeneratorFunction') return 'heavy';
        // If function declares 3+ formal params, assume at least medium complexity.
        if (typeof fnToAnalyze.length === 'number' && fnToAnalyze.length >= 3) return 'medium';
        // Otherwise prefer 'light' for simple unary functions, fall back to 'medium'.
        return 'light';
      } catch (e) {
        return 'medium';
      }
    }

    const fnComplexity =
      providedFnComplexity == null ? analyzeFnComplexity(fn) : providedFnComplexity;

    // Heuristic for chunk size when not explicitly provided.
    // For arrays we aim for roughly `poolSize * 4` chunks (work in flight) then
    // bias by `fnComplexity`. For unknown-length iterables pick a conservative
    // default sized to `poolSize` so we can stream efficiently.
    let chunkSize;
    if (explicitChunkSize && Number.isFinite(explicitChunkSize) && explicitChunkSize > 0) {
      chunkSize = Math.max(1, Math.floor(explicitChunkSize));
    } else if (total != null) {
      chunkSize = Math.max(1, Math.floor(total / Math.max(1, poolSize * 4)) || 1);
    } else {
      // streaming mode default
      chunkSize = Math.max(1, Math.floor(poolSize));
    }

    const explicitProvided =
      explicitChunkSize && Number.isFinite(explicitChunkSize) && explicitChunkSize > 0;
    if (!explicitProvided) {
      if (fnComplexity === 'light') chunkSize = Math.max(1, Math.floor(chunkSize * 2));
      else if (fnComplexity === 'heavy') chunkSize = Math.max(1, Math.floor(chunkSize / 2));
    }

    // If total is small, keep chunkSize small
    if (total > 0 && total < chunkSize) chunkSize = total;

    // Create a lightweight inline worker "class" compatible with PowerPool.
    // Each instance exposes: postMessage(msg, transfer?), addEventListener(), removeEventListener(), terminate(), onmessage, onerror
    function InlineWorkerFactory() {
      // this factory is used with `new` in PowerPool._createWorkerInstance
      const self = this;
      this.onmessage = null;
      this.onerror = null;
      this._alive = true;

      this.postMessage = function (message) {
        // decode transferable encodings created by the pool wrapper
        let decoded = message;
        try {
          if (message && (message instanceof ArrayBuffer || ArrayBuffer.isView(message))) {
            decoded = u82o(message);
          }
        } catch (e) {
          // fall back to raw message when decoding fails
          decoded = message;
        }
        const chunk = decoded && decoded.chunk ? decoded.chunk : decoded;
        // process asynchronously to mimic a real worker
        setTimeout(async () => {
          if (!self._alive) return;
          try {
            const results = new Array(chunk.length);
            const pending = [];
            for (let i = 0; i < chunk.length; i++) {
              try {
                const res = fn(chunk[i], i, chunk);
                if (res && typeof res.then === 'function') {
                  // async result: capture and resolve later
                  const idx = i;
                  pending.push(
                    res
                      .then((v) => {
                        results[idx] = v;
                      })
                      .catch((err) => {
                        results[idx] = {
                          error: true,
                          code: (err && err.code) || 'ERR_ITEM',
                          message: err && err.message,
                          stack: err && err.stack,
                        };
                        if (typeof self.onerror === 'function') {
                          try {
                            self.onerror(err);
                          } catch (ex) {
                            /* ignore */
                          }
                        }
                      })
                  );
                } else {
                  results[i] = res;
                }
              } catch (e) {
                // swallow per-item errors but surface to onerror if provided
                results[i] = normalizeError(e, 'ERR_ITEM');
                if (typeof self.onerror === 'function') {
                  try {
                    self.onerror(e);
                  } catch (ex) {
                    /* ignore */
                  }
                }
              }
            }

            if (pending.length) {
              try {
                await Promise.all(pending);
              } catch (e) {
                // errors for async items are handled per-promise above
              }
            }

            if (typeof self.onmessage === 'function') {
              try {
                const resp = { processed: chunk.length, results };
                // mirror correlationId if present on incoming message so the pool can resolve per-item Promises
                try {
                  if (decoded && decoded.correlationId != null)
                    resp.correlationId = decoded.correlationId;
                } catch (e) {
                  /* ignore */
                }
                self.onmessage({ data: resp });
              } catch (e) {
                if (typeof self.onerror === 'function') {
                  try {
                    self.onerror(e);
                  } catch (ex) {
                    /* ignore */
                  }
                }
              }
            }
          } catch (err) {
            if (typeof self.onerror === 'function') {
              try {
                self.onerror(err);
              } catch (ex) {
                /* ignore */
              }
            }
          }
        }, 0);
      };

      this.addEventListener = function (type, cb) {
        if (type === 'message') this.onmessage = cb;
        if (type === 'error') this.onerror = cb;
      };
      this.removeEventListener = function (type, cb) {
        if (type === 'message' && this.onmessage === cb) this.onmessage = null;
        if (type === 'error' && this.onerror === cb) this.onerror = null;
      };
      this.terminate = function () {
        this._alive = false;
      };
    }

    // Create a pool using the inline worker factory
    const pool = new PowerPool(InlineWorkerFactory, poolOptions);

    // If we had an array, enqueue chunks in batch for efficiency. For generic
    // iterables we stream chunk-sized slices and post them one-by-one to avoid
    // materializing the entire iterable.
    if (isArray) {
      const chunks = [];
      for (let i = 0; i < total; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));
      const batchItems = chunks.map((c) => ({ message: { chunk: c } }));
      pool.postMessageBatch(batchItems, postOptions);
      return pool;
    }

    // Streaming mode: iterate lazily and post each chunk immediately.
    (function streamIterableIntoPool(it, csize) {
      try {
        const iterator = it[Symbol.iterator]();
        let cur = [];
        for (let r = iterator.next(); !r.done; r = iterator.next()) {
          cur.push(r.value);
          if (cur.length >= csize) {
            try {
              pool.postMessage({ chunk: cur });
            } catch (e) {
              /* best-effort: continue streaming */
            }
            cur = [];
          }
        }
        if (cur.length) {
          try {
            pool.postMessage({ chunk: cur });
          } catch (e) {
            /* ignore */
          }
        }
      } catch (err) {
        // streaming failed: surface via logger but return pool regardless
        try {
          pool._logger.error(err, 'PowerChunker: failed while streaming iterable');
        } catch (e) {
          /* ignore */
        }
      }
    })(iterable, chunkSize);

    return pool;
  }
}
