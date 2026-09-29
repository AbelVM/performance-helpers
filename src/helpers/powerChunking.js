import { PowerPool } from './powerPool.js';
import { decodeInbound } from './powerMessageCodec.js';
import { normalizeError } from '../utils/errors.js';
import {
  CHUNKS_PER_WORKER_TARGET,
  CHUNK_WINDOW_MULTIPLIER,
  DEFAULT_HARDWARE_CONCURRENCY,
} from './constants.js';

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
  /**
   * @param {Iterable<*>} iterable - Items to process, chunked.
   * @param {Function} fn - Called once per chunk.
   * @param {PowerChunkingOptions} [options]
   */
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
    /** @type {any[]|null} */
    const items = isArray ? /** @type {any[]} */ (iterable) : null;
    /** @type {number|null} */
    const total = items ? items.length : null;

    const hw =
      (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) ||
      DEFAULT_HARDWARE_CONCURRENCY;
    const poolSize =
      Number.isFinite(poolOptions?.size) && poolOptions?.size > 0
        ? poolOptions.size
        : Math.max(1, hw);

    // Analyze `fn` to estimate complexity when the caller did not provide `fnComplexity`.
    const fnComplexity =
      providedFnComplexity == null ? analyzeFnComplexity(fn) : providedFnComplexity;

    // Heuristic for chunk size when not explicitly provided.
    // For arrays we aim for roughly `poolSize * 4` chunks (work in flight) then
    // bias by `fnComplexity`. For unknown-length iterables pick a conservative
    // default sized to `poolSize` so we can stream efficiently.
    let chunkSize;
    if (Number.isFinite(explicitChunkSize) && (explicitChunkSize ?? 0) > 0) {
      chunkSize = Math.max(1, Math.floor(explicitChunkSize ?? 1));
    } else if (total != null) {
      chunkSize = Math.max(
        1,
        Math.floor((total ?? 0) / Math.max(1, (poolSize ?? 1) * CHUNKS_PER_WORKER_TARGET)) || 1
      );
    } else {
      // streaming mode default
      chunkSize = Math.max(1, Math.floor(poolSize ?? 1));
    }

    const explicitProvided = Number.isFinite(explicitChunkSize) && (explicitChunkSize ?? 0) > 0;
    if (!explicitProvided) {
      if (fnComplexity === 'light') chunkSize = Math.max(1, Math.floor(chunkSize * 2));
      else if (fnComplexity === 'heavy') chunkSize = Math.max(1, Math.floor(chunkSize / 2));
    }

    // If total is small, keep chunkSize small
    if ((total ?? 0) > 0 && (total ?? 0) < chunkSize) chunkSize = total ?? 1;

    // Create a lightweight inline worker constructor tuned to `fn`.
    // Methods are placed on the prototype to avoid per-instance function allocations.
    const InlineWorkerFactory = makeInlineWorkerConstructor(fn);

    // Create a pool using the inline worker factory
    const pool = new PowerPool(InlineWorkerFactory, poolOptions);

    // If we had an array, enqueue chunks in batch for efficiency. For generic
    // iterables we stream chunk-sized slices and post them one-by-one to avoid
    // materializing the entire iterable.
    if (isArray) {
      dispatchArrayChunksInWindows(pool, items, total, chunkSize, postOptions, poolSize);
      return pool;
    }

    // Streaming mode: iterate lazily and post each chunk immediately.
    streamIterableIntoPool(pool, iterable, chunkSize);

    return pool;
  }
}

// Module-level helpers to avoid per-constructor allocations.
/**
 * Guess how expensive `fn` is, to bias the chunk-size heuristic.
 * @param {Function} fnToAnalyze
 * @returns {'light'|'medium'|'heavy'}
 */
function analyzeFnComplexity(fnToAnalyze) {
  try {
    const ctorName = fnToAnalyze?.constructor?.name;
    if (ctorName === 'AsyncFunction' || ctorName === 'GeneratorFunction') return 'heavy';
    if (typeof fnToAnalyze.length === 'number' && fnToAnalyze.length >= 3) return 'medium';
    return 'light';
  } catch (e) {
    return 'medium';
  }
}

/**
 * Defer work to a macrotask, preferring the one that is not a timer.
 *
 * `PowerChunker` builds inline workers in every environment, so this runs on
 * every batch. It has to yield: what it defers is user `fn` over a whole chunk
 * and must not block the event loop.
 *
 * **The scheduler has to be a macrotask, and the three candidates are not
 * interchangeable.** `queueMicrotask` is the fastest and is the wrong answer —
 * a run of them never yields, so a large job starves the event loop and the
 * "concurrency" is illusory. That much is why this was deferred rather than
 * just optimised, and the reasoning holds.
 *
 * `setTimeout(fn, 0)` yields, and is what this used. Node clamps a zero delay to
 * **1 ms**, and per turn that is expensive: 1057 µs against `setImmediate`'s
 * 1.74 µs, a 608x difference.
 *
 * **That 608x does not survive contact with the real workload, and the number
 * is recorded here because the same mistake is easy to repeat.** Measured per
 * turn, awaiting one at a time, it looks enormous. `PowerChunker` does not do
 * that: it posts every chunk as a *batch*, so the timers all expire at the same
 * moment and fire in one timers-phase pass. The 1 ms floor is paid **once per
 * batch**, not once per chunk. End to end, 2000 items:
 *
 * | `poolSize` | `setTimeout(fn, 0)` | `setImmediate(fn)` |
 * | ---------: | -------------------: | -----------------: |
 * |          1 |              1.5 ms |            0.8 ms  |
 * |          4 |              0.8 ms |            0.9 ms  |
 * |          8 |              0.7 ms |            0.8 ms  |
 *
 * So this is kept for correctness of intent, not for speed: `setImmediate` is
 * the primitive that means "run this soon without waiting for a timer", it
 * removes a Node timer dependency, and it drains FIFO so chunk order is
 * preserved. It is *not* a performance claim, and the test that asserted one
 * was deleted rather than loosened.
 *
 * Ordering: `setImmediate` drains its queue FIFO, as equal-delay timeouts do,
 * so chunks are still processed in the order they were posted.
 *
 * @type {(fn: () => void) => void}
 */
const deferToMacrotask =
  typeof setImmediate === 'function' ? (fn) => setImmediate(fn) : (fn) => setTimeout(fn, 0);

/**
 * Build a worker constructor that runs `fn` inline, for the case where the
 * caller has no worker source to hand the pool.
 * @param {Function} fn
 * @returns {new () => import('./jsdoc-types.js').WorkerLike}
 */
function makeInlineWorkerConstructor(fn) {
  return class InlineWorker {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
      this._alive = true;
      this._fn = fn;
    }

    /**
     * @param {any} message
     */
    postMessage(message) {
      // `decodeInbound` reads all three carriers — a framed message, a native
      // envelope, and a 1.x bare-JSON body. This block was the third copy of
      // that try-the-frame-and-fall-back dance in the codebase; the others are
      // `test/fixtures/echo.worker.js` and every worker in the wild.
      const decoded = decodeInbound(message).value;
      const chunk = decoded?.chunk ? decoded.chunk : decoded;
      const self = this;
      deferToMacrotask(async () => {
        if (!self._alive) return;
        try {
          const results = new Array(chunk.length);
          const pending = [];
          for (let i = 0; i < chunk.length; i++) {
            try {
              const res = self._fn(chunk[i], i, chunk);
              if (typeof res?.then === 'function') {
                const idx = i;
                pending.push(
                  res
                    .then(
                      /** @param {any} v */ (v) => {
                        results[idx] = v;
                      }
                    )
                    .catch(
                      /** @param {any} err */ (err) => {
                        results[idx] = {
                          error: true,
                          code: err?.code || 'ERR_ITEM',
                          message: err?.message,
                          stack: err?.stack,
                        };
                        if (typeof self.onerror === 'function') {
                          try {
                            self.onerror(err);
                          } catch (ex) {
                            /* ignore */
                          }
                        }
                      }
                    )
                );
              } else {
                results[i] = res;
              }
            } catch (e) {
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
              // handled per-promise
            }
          }

          if (typeof self.onmessage === 'function') {
            try {
              const resp = { processed: chunk.length, results, correlationId: undefined };
              if (decoded?.correlationId != null) resp.correlationId = decoded.correlationId;
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
      });
    }

    /**
     * @param {string} type
     * @param {any} cb
     */
    addEventListener(type, cb) {
      if (type === 'message') this.onmessage = cb;
      if (type === 'error') this.onerror = cb;
    }

    /**
     * @param {string} type
     * @param {any} cb
     */
    removeEventListener(type, cb) {
      if (type === 'message' && this.onmessage === cb) this.onmessage = null;
      if (type === 'error' && this.onerror === cb) this.onerror = null;
    }

    terminate() {
      this._alive = false;
    }
  };
}

/**
 * @param {any} pool
 * @param {any[]} items
 * @param {number} total
 * @param {number} chunkSize
 * @param {any} postOptions
 * @param {number} poolSize
 */
function dispatchArrayChunksInWindows(pool, items, total, chunkSize, postOptions, poolSize) {
  const totalChunks = Math.ceil(total / chunkSize);
  if (totalChunks <= 0) return;

  // Keep memory bounded by sending chunk descriptors in windows instead of one huge batch.
  const windowChunks = Math.max(
    1,
    Math.min(totalChunks, Math.max(1, poolSize * CHUNK_WINDOW_MULTIPLIER))
  );

  for (let chunkStart = 0; chunkStart < totalChunks; chunkStart += windowChunks) {
    const chunkEnd = Math.min(totalChunks, chunkStart + windowChunks);
    const batchItems = new Array(chunkEnd - chunkStart);

    for (let chunkIndex = chunkStart; chunkIndex < chunkEnd; chunkIndex++) {
      const offset = chunkIndex * chunkSize;
      batchItems[chunkIndex - chunkStart] = {
        message: { chunk: items.slice(offset, Math.min(total, offset + chunkSize)) },
      };
    }

    const dispatchResults = pool.postMessageBatch(batchItems, postOptions);
    const failedChunks = [];
    for (let i = 0; i < dispatchResults.length; i++) {
      if (dispatchResults[i] === false) failedChunks.push(chunkStart + i);
    }
    if (failedChunks.length) {
      notifyChunkDispatchFailure(pool, failedChunks, 'batch');
    }
  }
}

/**
 * @param {any} pool
 * @param {Iterable<any>} it
 * @param {number} csize
 */
function streamIterableIntoPool(pool, it, csize) {
  let chunkIndex = 0;
  try {
    const iterator = it[Symbol.iterator]();
    let cur = [];
    for (let r = iterator.next(); !r.done; r = iterator.next()) {
      cur.push(r.value);
      if (cur.length >= csize) {
        try {
          const accepted = pool.postMessage({ chunk: cur });
          if (accepted === false) {
            notifyChunkDispatchFailure(pool, [chunkIndex], 'stream');
          }
        } catch (e) {
          notifyChunkDispatchFailure(pool, [chunkIndex], 'stream', e);
        }
        cur = [];
        chunkIndex++;
      }
    }
    if (cur.length) {
      try {
        const accepted = pool.postMessage({ chunk: cur });
        if (accepted === false) {
          notifyChunkDispatchFailure(pool, [chunkIndex], 'stream');
        }
      } catch (e) {
        notifyChunkDispatchFailure(pool, [chunkIndex], 'stream', e);
      }
    }
  } catch (err) {
    notifyChunkDispatchFailure(pool, [chunkIndex], 'stream-iterate', err);
    try {
      pool?._logger?.error?.(err, 'PowerChunker: failed while streaming iterable');
    } catch (e) {
      /* ignore */
    }
  }
}

/**
 * @param {any} pool
 * @param {any[]} failedChunks
 * @param {string} mode
 * @param {unknown} [cause]
 */
function notifyChunkDispatchFailure(pool, failedChunks, mode, cause) {
  /** @type {any} */
  const err = new Error(`PowerChunker failed to dispatch ${failedChunks.length} chunk(s)`);
  err.code = 'ECHUNKDISPATCH';
  err.failedChunks = failedChunks.slice();
  err.mode = mode;
  if (cause) err.cause = cause;

  const emit = () => {
    try {
      if (typeof pool?.onerror === 'function') pool.onerror(err);
    } catch (e) {
      /* ignore */
    }
    pool?._bus?.emit?.('error', err);
    try {
      pool?._logger?.debug?.(err, 'PowerChunker dispatch failure');
    } catch (e) {
      /* ignore */
    }
  };

  if (typeof queueMicrotask === 'function') queueMicrotask(emit);
  else setTimeout(emit, 0);
}
