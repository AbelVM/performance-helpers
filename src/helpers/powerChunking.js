import { PowerPool } from './powerPool.js';
import { u82o } from './powerBuffer.js';
import { normalizeError } from '../utils/errors.js';

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
export function PowerChunking(iterable, fn, options = {}) {
  if (!iterable || typeof fn !== 'function') {
    throw new Error('PowerChunking requires an iterable and a function');
  }

  const {
    poolOptions = {},
    postOptions = {},
    chunkSize: explicitChunkSize,
    fnComplexity: providedFnComplexity,
  } = options;

  // Coerce iterable into an array so we can slice it into chunks.
  const items = Array.isArray(iterable) ? iterable : Array.from(iterable);
  const total = items.length;

  const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  const poolSize =
    poolOptions && Number.isFinite(poolOptions.size) && poolOptions.size > 0
      ? poolOptions.size
      : Math.max(1, hw);

  // Analyze `fn` to estimate complexity when the caller did not provide `fnComplexity`.
  function analyzeFnComplexity(fnToAnalyze) {
    try {
      const src = String(fnToAnalyze).toLowerCase();
      let score = 0;
      // loops are a strong indicator of heavier CPU per-item work
      const loops = (
        src.match(/\bfor\s*\(|\bwhile\s*\(|\.forEach\(|\.map\(|\.reduce\(|\.filter\(/g) || []
      ).length;
      score += loops * 2;
      // recursion or nested calls
      const nested = (
        src.match(/\breturn\b\s+.*\(|\bcallback\b|\bsettimeout\b|\bsetinterval\b/g) || []
      ).length;
      score += nested;
      // expensive operations hints
      const heavyOpsRegex =
        /json\.stringify|json\.parse|\.sort\(|math\.|new\s+regexp|regex|replace\(|match\(|exec\(|crypto\.|bigint|date\.|buffer\.|slice\(|splice\(/g;
      const heavyOps = (src.match(heavyOpsRegex) || []).length;
      score += heavyOps * 3;
      if (score >= 6) return 'heavy';
      if (score >= 2) return 'medium';
      return 'light';
    } catch (e) {
      return 'medium';
    }
  }

  const fnComplexity =
    providedFnComplexity == null ? analyzeFnComplexity(fn) : providedFnComplexity;

  // Heuristic for chunk size when not explicitly provided.
  // Aim for roughly `poolSize * 4` chunks (work in flight) then bias by fnComplexity.
  let chunkSize =
    explicitChunkSize && Number.isFinite(explicitChunkSize) && explicitChunkSize > 0
      ? Math.max(1, Math.floor(explicitChunkSize))
      : Math.max(1, Math.floor(total / Math.max(1, poolSize * 4)) || 1);

  const explicitProvided =
    explicitChunkSize && Number.isFinite(explicitChunkSize) && explicitChunkSize > 0;
  if (!explicitProvided) {
    if (fnComplexity === 'light') chunkSize = Math.max(1, Math.floor(chunkSize * 2));
    else if (fnComplexity === 'heavy') chunkSize = Math.max(1, Math.floor(chunkSize / 2));
  }

  // If total is small, keep chunkSize small
  if (total > 0 && total < chunkSize) chunkSize = total;

  // Build chunks
  const chunks = [];
  for (let i = 0; i < total; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }

  // Create a lightweight inline worker "class" compatible with PowerPool.
  // Each instance exposes: postMessage(msg, transfer?), addEventListener(), removeEventListener(), terminate(), onmessage, onerror
  function InlineWorkerFactory() {
    // this factory is used with `new` in PowerPool._createWorkerInstance
    const self = this;
    this.onmessage = null;
    this.onerror = null;
    this._alive = true;

    this.postMessage = function (message, transfer) {
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

  // Map chunks to postMessageBatch items: include the chunk under `chunk` key so our worker sees it.
  const batchItems = chunks.map((c) => ({ message: { chunk: c } }));

  // Forward postOptions to the pool's postMessageBatch
  pool.postMessageBatch(batchItems, postOptions);
  return pool;
}
