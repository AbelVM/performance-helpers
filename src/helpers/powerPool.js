/**
 * Lightweight web worker pool manager.
 *
 * A small, dependency-free pool that supports:
 * - reusing idle workers,
 * - growing the pool up to `maxSize`,
 * - optional task queuing when the pool is saturated,
 * - and terminating idle workers after `idleTimeout`.
 *
 * Additionally, the pool emits a synthetic `pool:idle` message when the
 * pool transitions to fully idle (no active tasks and an empty queue).
 * This allows consumers to react when all asynchronous work has completed.
 *
 *
 */
import { o2u8, u82o } from './powerBuffer.js';
import { nowMs } from '../utils/now.js';
import { PowerQueue } from './powerQueue.js';
import { PowerLogger } from './powerLogger.js';
import { PowerEventBus } from './powerEventBus.js';
import {
  DEFAULT_REAPER_MIN_INTERVAL_MS,
  ENCODE_CACHE_LARGE_KEY_LENGTH,
  DEFAULT_CACHE_DEFAULT_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_AUTOSCALE_MIN_INTERVAL_MS,
  DEFAULT_AUTOSCALE_INTERVAL_MS,
  DEFAULT_AUTOSCALE_COOLDOWN_MS,
  DEFAULT_AUTOSCALE_BACKOFF_MAX_MULTIPLIER,
} from './constants.js';

// Module-level tuning constants (imported from shared constants.js)

// Lightweight stable-shape wrapper for underlying worker-like objects.
// Extracted to module-level to avoid recreating the class on every
// `_addWorkerInstance()` call which reduces per-worker allocation cost
// and improves hidden-class stability in V8.
class WorkerWrapper {
  constructor(_underlying, _logger, _pool) {
    this._underlying = _underlying;
    this._logger = _logger;
    this._pool = _pool;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
  }

  postMessage(message, transfer) {
    let msg = message;
    let tr = transfer;
    const isTransferable =
      msg instanceof Uint8Array || ArrayBuffer.isView(msg) || msg instanceof ArrayBuffer;
    if (isTransferable) {
      if (Array.isArray(tr)) {
        try {
          if (tr.length) this._underlying.postMessage(msg, tr);
          else this._underlying.postMessage(msg);
          return;
        } catch (err) {
          this._logger.error(err, 'Failed to postMessage to underlying worker');
          throw err;
        }
      }

      if (!tr) {
        const buffer = msg instanceof ArrayBuffer ? msg : msg.buffer;
        if (buffer?.byteLength > 0) tr = [buffer];
      }

      try {
        if (tr?.length) this._underlying.postMessage(msg, tr);
        else this._underlying.postMessage(msg);
      } catch (err) {
        this._logger.error(err, 'Failed to postMessage to underlying worker');
        throw err;
      }
      return;
    }

    const isPlainObject =
      msg !== null &&
      typeof msg === 'object' &&
      !ArrayBuffer.isView(msg) &&
      !(msg instanceof ArrayBuffer);
    if (isPlainObject) {
      try {
        const u8 = this._pool._encodeForTransfer(message);
        // Efficiently ensure the encoded buffer is included in the transfer list
        if (!tr) {
          tr = [u8.buffer];
        } else if (Array.isArray(tr)) {
          if (!tr.includes(u8.buffer)) tr.push(u8.buffer);
        } else {
          // For array-like or other iterable transfer lists, convert once
          const arr = Array.from(tr);
          if (!arr.includes(u8.buffer)) arr.push(u8.buffer);
          tr = arr;
        }
        msg = u8;
      } catch (err) {
        tr = transfer;
        msg = message;
      }
    }

    try {
      if (tr?.length) this._underlying.postMessage(msg, tr);
      else this._underlying.postMessage(msg);
    } catch (err) {
      this._logger.error(err, 'Failed to postMessage to underlying worker');
      throw err;
    }
  }

  addEventListener(...args) {
    return this._underlying.addEventListener(...args);
  }

  removeEventListener(...args) {
    return this._underlying.removeEventListener(...args);
  }

  terminate() {
    if (typeof this._underlying.terminate === 'function') this._underlying.terminate();
  }
}

/**
 * PowerPoolShutdownError
 *
 * Error thrown when the `PowerPool` is shut down and pending tasks are rejected.
 *
 * @class PowerPoolShutdownError
 * @extends {Error}
 * @public
 */
export class PowerPoolShutdownError extends Error {
  constructor(message = 'PowerPool has been shut down') {
    super(message);
    this.name = 'PowerPoolShutdownError';
  }
}

/**
 * @typedef {import('./jsdoc-types.js').WorkerObj} WorkerObj
 */

/**
 * PostMessage and pending-response typedefs are defined centrally to avoid
 * duplication across multiple helper modules. Import aliases are used here
 * so typedoc and editors can resolve the shape while keeping local docs
 * concise.
 * @typedef {import('./jsdoc-types.js').PostMessageOptions} PostMessageOptions
 */

/**
 * @typedef {import('./jsdoc-types.js').PendingResponseEntry} PendingResponseEntry
 */

/**
 * @typedef {import('./jsdoc-types.js').PowerPoolOptions} PowerPoolOptions
 */

/**
 * Manager for a pool of web workers.
 *
 * @example
 * import MinionWorker from './worker.js?worker&inline'
 * const pool = new PowerPool(MinionWorker, { size: 4, idleTimeout: 30000 });
 * pool.onmessage = (e) => { logger.log(e.data); };
 * pool.postMessage({ payload: {} });
 */
/**
 * PowerPool
 *
 * Manager for a pool of worker-like objects providing task dispatch, queuing,
 * autoscaling, and lifecycle management. See constructor docs for options.
 *
 * @class PowerPool
 * @public
 */
export class PowerPool {
  /**
   * Create a PowerPool.
   *
   * @param {Function|string} workerSource - A Worker constructor, a worker factory, or a relative path string. If the provided function is not constructable, it is invoked directly; if a string path is provided, the pool attempts to resolve it via `new URL(path, import.meta.url)` before falling back to a plain `Worker(path)`.
   * @param {PowerPoolOptions=} options
   * @param {number} [options.size] - Initial number of workers to create.
   * @param {number} [options.minSize=1] - Minimum number of workers to keep alive.
   * @param {number} [options.maxSize] - Maximum number of workers allowed in the pool. The pool coerces this value to be at least `minSize`.
   * @param {Object} [options.workerOptions] - Options forwarded to the Worker constructor when using a string path.
   * @param {number} [options.maxTasksPerWorker=Infinity] - Soft capacity per worker before considering it busy.
   * @param {number} [options.idleTimeout=60000] - Milliseconds after which idle workers (beyond `minSize`) will be terminated.
   * @param {boolean} [options.taskQueue=true] - Whether to queue tasks when all workers are busy.
   * @param {'enqueue'|'drop-oldest'|'drop-newest'|'reject'} [options.queuePolicy='enqueue'] - Queue overflow behavior when the pool is saturated.
   * @param {boolean} [options.lazy=true] - If true, defer creating workers up to `size` until demand; only `minSize` workers are created at construction.
   */
  constructor(workerSource, options = {}) {
    const hwConcurrency = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
    const {
      size = Math.min(hwConcurrency, 2),
      minSize = 2,
      maxSize = Math.max(size, hwConcurrency),
      workerOptions = {},
      maxTasksPerWorker: maxTasksPerWorkerOption,
      idleTimeout = DEFAULT_CACHE_DEFAULT_TTL_MS,
      taskQueue = true,
      queuePolicy = 'enqueue',
      lazy = true,
      // default timeout (ms) applied to awaitResponse Promises when callers omit per-call timeout
      awaitResponseTimeout = DEFAULT_TIMEOUT_MS,
      autoScale = false,
    } = options;
    const maxTasksPerWorker =
      maxTasksPerWorkerOption === undefined && autoScale
        ? 1
        : (maxTasksPerWorkerOption ?? Infinity);

    // Validate workerSource early to fail fast on incorrect usage.
    if (typeof workerSource !== 'function' && typeof workerSource !== 'string') {
      throw new TypeError('PowerPool workerSource must be a function or string');
    }

    this._workerSource = workerSource;
    this._workerOptions = workerOptions;
    this._maxTasksPerWorker = maxTasksPerWorker;
    this.minSize = Math.max(0, minSize);
    this.maxSize = Math.max(this.minSize, maxSize);
    this.idleTimeout = Math.max(0, idleTimeout);
    this.taskQueueEnabled = Boolean(taskQueue);
    this._queuePolicy = ['enqueue', 'drop-oldest', 'drop-newest', 'reject'].includes(queuePolicy)
      ? queuePolicy
      : 'enqueue';

    // performance tracking
    this._createdAt = nowMs(); // pool creation timestamp (ms)
    this._totalWorkersCreated = 0; // increments for every created worker instance
    this._totalTasksCompleted = 0; // increments for every finished task
    // Welford streaming statistics for O(1) memory: count, mean, M2 (for variance)
    this._taskDurationsWelfordCount = 0;
    this._taskDurationsWelfordMean = 0;
    this._taskDurationsWelfordM2 = 0;
    this._taskDurationsMin = Number.POSITIVE_INFINITY;
    this._taskDurationsMax = Number.NEGATIVE_INFINITY;
    // optional autoscaling configuration (disabled by default)
    this._ewmaLatency = null; // pool-level EWMA for recent task latency (ms)
    this._autoScale = null; // { enabled, intervalMs, targetMs, alpha, cooldownMs, hysteresis }
    this._autoScaleInterval = null;
    this._lastAutoScaleAt = 0; // timestamp (ms) of last scale action (0=never)
    // running aggregate for terminated workers: total completed tasks and count
    this._terminatedWorkerTaskCountsTotal = 0;
    this._terminatedWorkerTaskCountsCount = 0;

    /** @type {WorkerObj[]} */
    this.workers = [];
    this.queue = new PowerQueue();
    const busOptions = {
      maxListeners: options?.listenerMaxListeners ?? options?.maxListeners,
      weak: Boolean(options?.weakListeners),
    };
    this._bus = new PowerEventBus(busOptions);
    // optional queue high-watermark threshold for emitting backpressure events
    this._queueHighThreshold = Number.isFinite(Number(options?.queueHighThreshold))
      ? Math.max(0, Math.floor(Number(options?.queueHighThreshold)))
      : Infinity;
    this._queueHighCrossed = false; // track current high state to avoid event spam
    this._onmessage = null;
    this._onerror = null;
    this._onidle = null;
    this._onresize = null;
    this._nextIndex = 0;
    // monotonic id allocator for workers to ensure ids remain unique
    this._nextWorkerId = 0;
    // monotonic per-pool correlation counter appended to generated ids
    this._correlationCounter = 0;
    /** number of currently active (dispatched) tasks across all workers */
    this._activeTasks = 0;
    /** whether the pool is considered idle (no active tasks and empty queue) */
    this._isIdle = true;
    /** whether queued dispatch is paused */
    this._queuePaused = false;

    // Create a per-instance logger. Allow callers to override via options.debugLevel (default 1).
    const dbg = typeof options?.debugLevel === 'number' ? options.debugLevel : 1;
    this._logger = new PowerLogger(dbg, { name: 'powerPool' });
    // Basic options validation: when an explicit options argument is provided it must be an object
    if (arguments.length > 1 && arguments[1] != null && typeof arguments[1] !== 'object') {
      throw new TypeError('PowerPool options must be an object');
    }
    // correlation map for Promise-style postMessage responses
    this._pendingResponses = new Map(); // correlationId -> { resolve, reject, timer }
    // map underlying worker -> WorkerObj for shared handler dispatch
    this._underlyingToWorkerObj = new Map();

    // pool-level default awaitResponse timeout (ms). `0` means disabled.
    this._defaultAwaitResponseTimeout = Number.isFinite(Number(awaitResponseTimeout))
      ? Math.max(0, Math.floor(Number(awaitResponseTimeout)))
      : DEFAULT_TIMEOUT_MS;

    // When `lazy` is truthy only create `minSize` workers now and allow the
    // pool to grow on demand when tasks are posted. Default is `true`.
    const initial = lazy
      ? Math.min(this.minSize, this.maxSize)
      : Math.min(Math.max(size, this.minSize), this.maxSize);
    for (let i = 0; i < initial; i++) {
      try {
        this._addWorkerInstance();
      } catch (err) {
        // If the error signals an invalid workerSource type, rethrow so
        // callers (and tests) can observe the contract violation.
        try {
          const msg = err?.message ? String(err.message) : '';
          if (msg.includes('Invalid workerSource')) throw err;
        } catch (re) {
          throw re;
        }
        try {
          this._logger.error(err, 'Initial worker creation failed');
        } catch (e) {
          this._debugLog?.(e, 'Initial worker creation: logger error');
        }
        try {
          this._bus.emit('pool:error', { phase: 'init', error: err });
        } catch (e) {
          this._debugLog?.(e, 'Initial worker creation: bus.emit failed');
        }
        break;
      }
    }

    // reaper checks periodically and terminates idle workers
    this._reaperInterval = setInterval(
      () => this._reapIdleWorkers(),
      Math.max(DEFAULT_REAPER_MIN_INTERVAL_MS, Math.floor(this.idleTimeout / 2))
    );
    // no Node `crypto` import: prefer Web Crypto APIs where available
    // small LRU-like cache for encoded messages (keyed by JSON string)
    // stores recent serialized messages to avoid re-encoding identical messages
    this._encodeCache = new Map();
    this._encodeCacheLimit = Math.max(
      16,
      options?.encodeCacheLimit ? options.encodeCacheLimit : 64
    );
    // Optional byte-size limit for the encode cache. When provided the cache
    // will evict oldest entries until the total cached bytes fit within this
    // limit. Default is `Infinity` (disabled) to preserve existing behavior.
    this._encodeCacheByteLimit = Number.isFinite(Number(options?.encodeCacheByteLimit))
      ? Math.max(0, Number(options?.encodeCacheByteLimit))
      : Infinity;
    // Running total of bytes stored in `_encodeCache` (Uint8Array.byteLength)
    this._encodeCacheBytes = 0;

    // configure optional autoscaling
    if (options?.autoScale) {
      const as = typeof options.autoScale === 'object' ? options.autoScale : {};
      const intervalMs = Number.isFinite(Number(as.intervalMs))
        ? Math.max(DEFAULT_AUTOSCALE_MIN_INTERVAL_MS, Math.floor(as.intervalMs))
        : DEFAULT_AUTOSCALE_INTERVAL_MS;
      const targetMs = Number.isFinite(Number(as.targetMs)) ? Math.max(1, Number(as.targetMs)) : 50;
      const alpha = Number.isFinite(Number(as.alpha))
        ? Math.max(0, Math.min(1, Number(as.alpha)))
        : 0.2;
      const cooldownMs = Number.isFinite(Number(as.cooldownMs))
        ? Math.max(0, Math.floor(as.cooldownMs))
        : DEFAULT_AUTOSCALE_COOLDOWN_MS;
      const hysteresis = Number.isFinite(Number(as.hysteresis))
        ? Math.max(0, Math.min(1, Number(as.hysteresis)))
        : 0.2;
      // stepUp/stepDown: allow multi-step scaling per tick (default 1)
      const stepUp = Number.isFinite(Number(as.stepUp))
        ? Math.max(1, Math.floor(Number(as.stepUp)))
        : 1;
      const stepDown = Number.isFinite(Number(as.stepDown))
        ? Math.max(1, Math.floor(Number(as.stepDown)))
        : 1;
      // backoff controls multiplicative increase of cooldown after successive scale actions
      const backoffFactor = Number.isFinite(Number(as.backoffFactor))
        ? Math.max(1, Number(as.backoffFactor))
        : 1;
      const backoffMaxMultiplier = Number.isFinite(Number(as.backoffMaxMultiplier))
        ? Math.max(1, Number(as.backoffMaxMultiplier))
        : DEFAULT_AUTOSCALE_BACKOFF_MAX_MULTIPLIER;
      // time (ms) since last scale after which backoff multiplier is reset to 1
      const backoffResetMs = Number.isFinite(Number(as.backoffResetMs))
        ? Math.max(0, Math.floor(Number(as.backoffResetMs)))
        : cooldownMs * 4;

      this._autoScale = {
        enabled: true,
        intervalMs,
        targetMs,
        alpha,
        cooldownMs,
        hysteresis,
        stepUp,
        stepDown,
        backoffFactor,
        backoffMaxMultiplier,
        backoffResetMs,
      };
      // runtime backoff multiplier (starts at 1)
      this._autoScaleBackoffMultiplier = 1;
      // start periodic autoscale tick
      try {
        this._autoScaleInterval = setInterval(() => this._autoScaleTick(), intervalMs);
      } catch (e) {
        this._debugLog?.(e, 'autoScale: interval setup failed');
      }
    }
  }

  /* Node crypto dynamic import removed to avoid bundler externalization. */

  /**
   * Log debug information about swallowed errors when debug logging is enabled.
   * @private
   */
  _debugLog(err, msg) {
    try {
      if (typeof this._logger?.debug === 'function') {
        if (err) this._logger.debug(err, msg || 'swallowed error');
        else this._logger.debug(msg || 'swallowed error');
      }
    } catch (e) {
      try {
        if (typeof console !== 'undefined' && typeof console.debug === 'function')
          console.debug(e, msg || 'swallowed error');
      } catch (_) {}
    }
  }

  /** Ensure the reaper interval exists; recreate it if missing. @private */
  _ensureReaper() {
    try {
      if (!this._reaperInterval) {
        this._reaperInterval = setInterval(
          () => this._reapIdleWorkers(),
          Math.max(DEFAULT_REAPER_MIN_INTERVAL_MS, Math.floor(this.idleTimeout / 2))
        );
      }
    } catch (e) {
      this._debugLog?.(e, '_ensureReaper: setInterval failed');
    }
  }

  /*
   * Create and register a pending response entry for a given correlation id.
   * Returns `{ pendingPromise, correlationKey }` where `pendingPromise` is
   * the Promise that will be resolved/rejected when the response arrives
   * or when the per-call/pool timeout elapses.
   * @private
   */
  _createPendingResponsePromise(correlationId, options) {
    const correlationKey = correlationId != null ? String(correlationId) : correlationId;
    let entry = null;
    const pendingPromise = new Promise((resolve, reject) => {
      entry = { resolve, reject, timer: null };
      const perCallTimeout = Number.isFinite(Number(options?.timeout))
        ? Math.max(0, Math.floor(Number(options?.timeout)))
        : Number.isFinite(Number(this._defaultAwaitResponseTimeout))
          ? this._defaultAwaitResponseTimeout
          : undefined;
      if (Number.isFinite(perCallTimeout) && perCallTimeout > 0) {
        entry.timer = setTimeout(() => {
          try {
            this._cleanupPendingResponse(correlationKey, {
              rejectWith: new Error('postMessage response timeout'),
            });
          } catch (e) {
            try {
              reject(new Error('postMessage response timeout'));
            } catch (e2) {
              this._debugLog?.(e2, 'createPendingResponsePromise: reject fallback failed');
            }
          }
        }, perCallTimeout);
      }
      this._pendingResponses.set(correlationKey, entry);
    });
    return { pendingPromise, correlationKey };
  }

  /**
   * Post a prepared message to a specific worker object and update bookkeeping.
   * Returns the `pendingPromise` when `wantResponse` is true, otherwise `true` on success.
   * On failure, rejects/cleans up the pending response when applicable and
   * returns `pendingPromise` (when awaiting) or `false`.
   * @private
   */
  _postToWorkerObj(obj, prepared, startTime, wantResponse, correlationKey, pendingPromise) {
    try {
      if (prepared.transfer?.length) obj.worker.postMessage(prepared.message, prepared.transfer);
      else obj.worker.postMessage(prepared.message);
      if (typeof obj._startTimes?.push === 'function') obj._startTimes.push(startTime);
      obj.tasks++;
      this._activeTasks++;
      obj.lastActive = startTime;
      if (this._isIdle) this._updateIdleState();
      return wantResponse ? pendingPromise : true;
    } catch (err) {
      if (wantResponse && correlationKey) {
        try {
          this._cleanupPendingResponse(correlationKey, { rejectWith: err });
        } catch (e) {
          this._debugLog?.(e, 'postToWorkerObj: cleanupPendingResponse failed');
        }
        try {
          this._logger.error(err, 'Failed to postMessage to worker');
        } catch (e) {
          this._debugLog?.(e, 'postToWorkerObj: logger.error failed');
        }
        return pendingPromise;
      }
      try {
        this._logger.error(err, 'Failed to postMessage to worker');
      } catch (e) {
        this._debugLog?.(e, 'postToWorkerObj: logger.error failed');
      }
      return false;
    }
  }

  /**
   * Attempt to grow the pool by adding a worker and dispatching the message.
   * Preserves the same pending-response cleanup semantics as inline logic.
   * @private
   */
  _tryGrowPool(
    message,
    transfer,
    options,
    startTime,
    wantResponse,
    correlationKey,
    pendingPromise
  ) {
    let obj;
    try {
      obj = this._addWorkerInstance();
    } catch (err) {
      try {
        this._logger.error(err, 'Failed to grow pool');
      } catch (e) {
        this._debugLog?.(e, 'tryGrowPool: logger.error failed');
      }
      try {
        this._bus.emit('pool:error', { phase: 'grow', error: err });
      } catch (e) {
        this._debugLog?.(e, 'tryGrowPool: bus.emit failed');
      }
      if (wantResponse && correlationKey) {
        try {
          this._cleanupPendingResponse(correlationKey, { rejectWith: err });
        } catch (e) {
          this._debugLog?.(e, 'tryGrowPool: cleanupPendingResponse failed');
        }
        return pendingPromise;
      }
      return false;
    }
    if (!obj) {
      if (wantResponse && correlationKey) {
        try {
          this._cleanupPendingResponse(correlationKey, {
            rejectWith: new Error('failed to add worker'),
          });
        } catch (e) {
          this._debugLog?.(e, 'tryGrowPool: cleanupPendingResponse failed');
        }
        return pendingPromise;
      }
      return false;
    }
    const prepared = this._prepareForTransfer(message, transfer, options);
    return this._postToWorkerObj(
      obj,
      prepared,
      startTime,
      wantResponse,
      correlationKey,
      pendingPromise
    );
  }

  /**
   * Enqueue or reject a prepared message according to the configured queue policy.
   * Returns `pendingPromise`/`true`/`false` to match `postMessage` semantics.
   * @private
   */
  _enqueueOrReject(prepared, wantResponse, correlationKey, pendingPromise) {
    const policy = this._queuePolicy;
    if (policy === 'reject') {
      if (wantResponse && correlationKey) {
        this._cleanupPendingResponse(correlationKey, {
          rejectWith: new Error('postMessage rejected by queue policy'),
        });
        return pendingPromise;
      }
      return false;
    }
    if (policy === 'drop-newest' && this.queue.length > 0) {
      if (wantResponse && correlationKey) {
        this._cleanupPendingResponse(correlationKey, {
          rejectWith: new Error('postMessage rejected by queue policy'),
        });
        return pendingPromise;
      }
      return false;
    }
    if (policy === 'drop-oldest' && this.queue.length > 0) {
      const dropped = this.queue.shift();
      if (dropped?.correlationId != null) {
        this._cleanupPendingResponse(dropped.correlationId, {
          rejectWith: new Error('postMessage queued task dropped by policy'),
        });
      }
    }
    const queuedItem = { message: prepared.message, transfer: prepared.transfer };
    if (wantResponse && correlationKey) queuedItem.correlationId = correlationKey;
    this.queue.push(queuedItem);
    try {
      if (
        Number.isFinite(this._queueHighThreshold) &&
        this.queue.length > this._queueHighThreshold &&
        !this._queueHighCrossed
      ) {
        this._queueHighCrossed = true;
        this._bus.emit('pool:queue:high', {
          length: this.queue.length,
          threshold: this._queueHighThreshold,
        });
      }
    } catch (e) {
      this._debugLog?.(e, 'enqueueOrReject: bus.emit failed');
    }
    this._updateIdleState();
    return wantResponse ? pendingPromise : true;
  }

  /**
   * Clear lifecycle timer intervals used by the pool.
   * @private
   */
  _clearLifecycleIntervals() {
    try {
      if (this._reaperInterval) {
        clearInterval(this._reaperInterval);
        this._reaperInterval = null;
      }
    } catch (e) {
      this._debugLog?.(e, 'clearLifecycleIntervals: clearInterval(reaper) failed');
    }
    try {
      if (this._autoScaleInterval) {
        clearInterval(this._autoScaleInterval);
        this._autoScaleInterval = null;
      }
    } catch (e) {
      this._debugLog?.(e, 'clearLifecycleIntervals: clearInterval(autoScale) failed');
    }
  }

  /**
   * Shutdown the pool: clear timers, reject pending responses, terminate workers,
   * and clear internal queues. This is a full stop that prevents background
   * timers from keeping the process alive.
   */
  shutdown() {
    this._clearLifecycleIntervals();

    // reject pending responses (centralized to avoid races)
    try {
      for (const [cid] of this._pendingResponses) {
        try {
          this._cleanupPendingResponse(cid, {
            rejectWith: new PowerPoolShutdownError('pool:shutdown'),
          });
        } catch (e) {
          this._debugLog?.(e, 'shutdown: cleanup pending response');
        }
      }
      // Ensure the map is empty in case individual cleanup failed
      try {
        if (typeof this._pendingResponses?.clear === 'function') this._pendingResponses.clear();
      } catch (e) {
        this._debugLog?.(e, 'shutdown: pendingResponses.clear failed');
      }
    } catch (e) {
      this._debugLog?.(e, 'shutdown: iterate pending responses');
    }

    // terminate workers
    try {
      for (const w of this.workers) {
        try {
          w.worker.terminate();
        } catch (e) {
          this._debugLog?.(e, 'shutdown: terminate worker');
        }
      }
    } catch (e) {
      this._debugLog?.(e, 'shutdown: terminate workers loop');
    }

    // clear underlying -> worker map to avoid retaining references
    try {
      if (this._underlyingToWorkerObj) this._underlyingToWorkerObj.clear();
    } catch (e) {
      this._debugLog?.(e, 'shutdown: underlyingToWorkerObj.clear failed');
    }

    // emit pool:scale for shutdown removals
    // compute a snapshot of terminated worker ids for reporting
    const _terminated = this.workers.map((w) => w?.id).filter((x) => x != null);
    if (_terminated?.length) {
      this._bus.emit('pool:scale', {
        action: 'remove',
        terminated: _terminated,
        count: _terminated.length,
      });
    }

    // reset state
    this.workers = [];
    this.queue = new PowerQueue();
    this._queueHighCrossed = false;
    this._activeTasks = 0;
  }

  /**
   * Encode a plain object to a Uint8Array, using a small cache to avoid
   * repeated encoding work for identical messages. Returns a Uint8Array.
   * @private
   * @param {Object} obj
   * @returns {Uint8Array}
   */
  _encodeForTransfer(obj) {
    try {
      const s = JSON.stringify(obj);
      // Avoid caching extremely large JSON keys which could bloat the
      // encode cache. For very large serialized payloads, skip caching
      // and return the encoded Uint8Array directly.
      if (typeof s === 'string' && s.length > ENCODE_CACHE_LARGE_KEY_LENGTH) {
        return o2u8(obj);
      }
      const hit = this._encodeCache.get(s);
      if (hit) {
        // Move to the end to mark as recently used (LRU behavior).
        try {
          this._encodeCache.delete(s);
          this._encodeCache.set(s, hit);
        } catch (e) {
          /* ignore cache update errors */
        }
        return hit;
      }
      const u8 = o2u8(obj);
      // Evict least-recently-used (oldest insertion) when over entry-count
      // limit or when adding this entry would exceed the byte-size limit.
      const willBeBytes = u8?.byteLength || 0;
      const needEviction = () =>
        this._encodeCache.size >= this._encodeCacheLimit ||
        (this._encodeCacheByteLimit !== Infinity &&
          this._encodeCacheBytes + willBeBytes > this._encodeCacheByteLimit);
      // Batch-evict oldest entries to reduce Map iterator/delete churn
      while (needEviction()) {
        const keysToDelete = [];
        const it = this._encodeCache.keys();
        const BATCH = 10;
        while (needEviction() && keysToDelete.length < BATCH) {
          const nxt = it.next();
          if (nxt.done) break;
          keysToDelete.push(nxt.value);
        }
        if (!keysToDelete.length) break;
        for (const k of keysToDelete) {
          try {
            const removed = this._encodeCache.get(k);
            const removedBytes = typeof removed?.byteLength === 'number' ? removed.byteLength : 0;
            this._encodeCacheBytes = Math.max(0, this._encodeCacheBytes - removedBytes);
          } catch (e) {
            /* ignore bookkeeping errors */
          }
          this._encodeCache.delete(k);
        }
      }
      this._encodeCache.set(s, u8);
      if (u8?.byteLength) this._encodeCacheBytes += u8.byteLength;
      return u8;
    } catch (err) {
      // Fall back to direct encoding attempt
      return o2u8(obj);
    }
  }

  /**
   * Prepare a transferable Uint8Array for the given object.
   * Returns a new Uint8Array when `clone` is true (safe to transfer), or
   * the cached Uint8Array when `clone` is false (do not transfer the returned buffer).
   * @param {Object} obj
   * @param {{clone?:boolean}=} options
   * @returns {Uint8Array}
   */
  prepareBuffer(obj, options = {}) {
    const { clone = true } = options;
    const shared = this._encodeForTransfer(obj);
    return clone ? shared.slice() : shared;
  }

  /**
   * Prepare an array of transferable buffers for a batch of items.
   * Each item may be a plain object, a TypedArray/ArrayBuffer view, or
   * an object `{ message, transfer? }`. The returned array contains
   * normalized `{ message, transfer }` entries ready for `postMessageBatch`.
   * By default each buffer is a cloned Uint8Array safe to transfer; pass
   * `{ clone: false }` to return references to internal cached buffers
   * (do NOT transfer those buffers if `clone:false`).
   *
   * @param {Array<any|{message:any,transfer?:Transferable[]}>} items
   * @param {{clone?:boolean}=} options
   * @returns {{message:*,transfer:Transferable[]|undefined}[]}
   */
  prepareBuffers(items, options = {}) {
    if (!Array.isArray(items)) throw new Error('prepareBuffers expects an array');
    const { clone = true, zeroCopy = false } = options;
    const out = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const it =
        items[i] && typeof items[i] === 'object' && 'message' in items[i]
          ? items[i]
          : { message: items[i] };
      const msg = it.message;
      const tr = it.transfer;
      if (tr) {
        out[i] = { message: msg, transfer: tr };
        continue;
      }
      // plain object -> encode via cache
      const isPlainObject =
        msg !== null &&
        typeof msg === 'object' &&
        !ArrayBuffer.isView(msg) &&
        !(msg instanceof ArrayBuffer);
      if (isPlainObject) {
        if (zeroCopy) {
          out[i] = { message: msg, transfer: undefined };
          continue;
        }
        try {
          const u8 = this._encodeForTransfer(msg);
          const buf = clone ? u8.slice() : u8;
          out[i] = { message: buf, transfer: clone ? [buf.buffer] : undefined };
          continue;
        } catch (err) {
          out[i] = { message: msg, transfer: undefined };
          continue;
        }
      }
      // ArrayBuffer or ArrayBuffer view -> make transferable in one normalized fast path.
      if (msg instanceof ArrayBuffer || ArrayBuffer.isView(msg)) {
        const transferTarget = msg instanceof ArrayBuffer ? msg : msg.buffer;
        out[i] = { message: msg, transfer: [transferTarget] };
        continue;
      }
      // fallback: keep as-is
      out[i] = { message: msg, transfer: undefined };
    }
    return out;
  }

  /**
   * Class-level helper to prepare a message and optional transfer list for posting to a worker.
   * Accepts `opts` with `zeroCopy` flag to control forwarding of raw buffers.
   * @private
   */
  _prepareForTransfer(msg, tr, opts) {
    const zeroCopy = Boolean(opts?.zeroCopy);
    if (msg instanceof Uint8Array || ArrayBuffer.isView(msg) || msg instanceof ArrayBuffer) {
      const transferTarget = msg instanceof ArrayBuffer ? msg : msg.buffer;
      if (!tr) {
        if (transferTarget?.byteLength === 0) {
          try {
            const copy = msg instanceof ArrayBuffer ? msg.slice(0) : new Uint8Array(msg);
            return { message: copy, transfer: [copy.buffer] };
          } catch (err) {
            return { message: msg, transfer: undefined };
          }
        }
        return { message: msg, transfer: [transferTarget] };
      }
      if (Array.isArray(tr)) {
        return { message: msg, transfer: tr };
      }
      if (tr.length === 0) {
        return { message: msg, transfer: [transferTarget] };
      }
      const arr = [];
      let found = false;
      for (const item of tr) {
        arr.push(item);
        if (item === transferTarget) found = true;
      }
      if (!found) arr.push(transferTarget);
      return { message: msg, transfer: arr };
    }

    const isPlainObject =
      msg !== null &&
      typeof msg === 'object' &&
      !ArrayBuffer.isView(msg) &&
      !(msg instanceof ArrayBuffer);
    if (isPlainObject) {
      if (zeroCopy) return { message: msg, transfer: tr };
      try {
        const u8 = this._encodeForTransfer(msg);
        const buf = u8.slice();
        let transferList = tr;
        if (!transferList || (Array.isArray(transferList) && transferList.length === 0)) {
          transferList = [buf.buffer];
        } else if (!Array.isArray(transferList)) {
          if (transferList.length === 0) {
            transferList = [buf.buffer];
          } else {
            const arr = [];
            let found = false;
            for (const item of transferList) {
              arr.push(item);
              if (item === buf.buffer) found = true;
            }
            if (!found) arr.push(buf.buffer);
            transferList = arr;
          }
        } else {
          let found = false;
          for (const item of transferList) {
            if (item === buf.buffer) {
              found = true;
              break;
            }
          }
          if (!found) transferList = [...transferList, buf.buffer];
        }
        return { message: buf, transfer: transferList };
      } catch (err) {
        return { message: msg, transfer: tr };
      }
    }
    return { message: msg, transfer: tr };
  }

  /**
   * Decrement the global active task counter safely.
   * Ensures the counter never goes negative and centralizes error handling.
   * @private
   * @param {number} [n=1]
   */
  _decrementActiveTasks(n = 1) {
    try {
      const dec = Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 1;
      this._activeTasks = Math.max(0, this._activeTasks - dec);
    } catch (err) {
      this._activeTasks = 0;
    }
  }

  /**
   * Resize the pool's maximum size at runtime.
   * If `n` is smaller than the current number of workers, extra workers
   * will be terminated (keeps at least `minSize`). If `n` is larger,
   * the pool may grow up to the new limit when demand increases.
   * @param {number} n - New maximum pool size.
   */
  resize(n) {
    // overload: resize(number) or resize({ minSize, maxSize })
    let newMin = this.minSize;
    let newMax = this.maxSize;
    if (n != null && typeof n === 'object') {
      if (Number.isFinite(n.minSize)) newMin = Math.max(0, Math.floor(n.minSize));
      if (Number.isFinite(n.maxSize)) newMax = Math.max(newMin, Math.floor(n.maxSize));
    } else {
      // numeric shorthand: set maxSize, keep minSize
      const v = Number(n);
      if (!Number.isFinite(v)) return;
      newMax = Math.max(newMin, Math.floor(v));
    }

    // apply new bounds
    this.minSize = Math.max(0, newMin);
    this.maxSize = Math.max(this.minSize, newMax);

    // If we need to grow to satisfy new minSize, create workers up to minSize (respecting maxSize)
    let added = 0;
    while (this.workers.length < this.minSize && this.workers.length < this.maxSize) {
      try {
        const before = this.workers.length;
        this._addWorkerInstance();
        if (this.workers.length === before) break;
        added++;
      } catch (err) {
        try {
          this._logger.error(err, 'resize: add worker failed');
        } catch (e) {
          this._debugLog?.(e, 'resize: logger.error failed');
        }
        try {
          this._bus.emit('pool:error', { phase: 'resize', error: err });
        } catch (e) {
          this._debugLog?.(e, 'resize: bus.emit failed');
        }
        break;
      }
    }

    // If we have more workers than the new max, terminate excess workers
    const terminatedIds = [];
    while (this.workers.length > this.maxSize) {
      const w = this.workers.pop();
      if (w) {
        // adjust active task counter if worker had inflight tasks
        this._decrementActiveTasks(w.tasks || 0);
        try {
          w.worker.terminate();
        } catch (e) {
          this._debugLog?.(e, 'resize: worker.terminate failed');
        }
        this._deleteWorkerUnderlyingMapping(w);
        this._terminatedWorkerTaskCountsTotal += w.completedTasks || 0;
        this._terminatedWorkerTaskCountsCount += 1;
        terminatedIds.push(w.id);
      }
    }

    // emit resize event/callback when workers were terminated or added
    if (terminatedIds.length || added) {
      const ev = {
        data: {
          type: 'pool:resize',
          terminated: terminatedIds,
          added,
        },
      };
      if (this._onresize) {
        try {
          this._onresize(ev);
        } catch (err) {
          this._logger.error(err, 'Pool onresize handler error');
        }
      }
      this._bus.emit('resize', ev);
      // also emit pool:scale with details about added/removed workers
      this._bus.emit('pool:scale', {
        added,
        terminated: terminatedIds,
        minSize: this.minSize,
        maxSize: this.maxSize,
      });
    }

    // Re-evaluate idle state after resizing
    this._updateIdleState();
  }

  /**
   * Create a new worker instance using the configured source.
   *
   * This helper normalizes the configured `workerSource` which may be a
   * callable factory (constructor) or a string path. When a string path is
   * provided it attempts to resolve a `baseUrl` at runtime in a bundler-safe
   * manner and constructs a `Worker` accordingly. Throws when `workerSource`
   * is neither a function nor a string.
   *
   * @private
   * @returns {Worker|any} The underlying worker instance or factory result.
   * @throws {Error} When `workerSource` is invalid or worker construction fails.
   */
  _createWorkerInstance() {
    if (typeof this._workerSource === 'function') {
      const source = this._workerSource;
      if (source.prototype === undefined) {
        // Arrow functions and bound functions are not constructable.
        return source();
      }
      try {
        return new source();
      } catch (err) {
        const msg = String(err?.message);
        if (
          err instanceof TypeError &&
          /not a constructor|cannot be invoked without\s*'new'|Class constructor|not constructable/i.test(
            msg
          )
        ) {
          // Not constructable: try invoking as a factory function.
          return source();
        }
        throw err;
      }
    }

    if (typeof this._workerSource === 'string') {
      let baseUrl;
      try {
        // Attempt to read `import.meta.url` at runtime using a dynamic
        // function so bundlers won't statically parse `import.meta`.
        // If unavailable this will throw or return undefined.
        // eslint-disable-next-line no-new-func
        baseUrl = new Function('try { return import.meta?.url } catch (e) { return undefined }')();
      } catch (e) {
        baseUrl = undefined;
      }

      if (!baseUrl && typeof document !== 'undefined') {
        const cs = document.currentScript;
        if (cs?.src) baseUrl = cs.src;
      }

      if (!baseUrl && typeof location !== 'undefined' && location.href) baseUrl = location.href;

      try {
        if (baseUrl) return new Worker(new URL(this._workerSource, baseUrl), this._workerOptions);
      } catch (e) {
        // Fallthrough to try creating a worker directly from the string
      }

      return new Worker(this._workerSource, this._workerOptions);
    }

    throw new Error('Invalid workerSource: expected Worker factory or relative path string');
  }

  _deleteWorkerUnderlyingMapping(workerObj) {
    try {
      const u = workerObj?.worker?._underlying;
      if (u && this._underlyingToWorkerObj) this._underlyingToWorkerObj.delete(u);
    } catch (e) {
      this._debugLog?.(e, '_deleteWorkerUnderlyingMapping failed');
    }
  }

  /**
   * Add and wire a new worker instance into the pool.
   *
   * This helper wraps the underlying worker instance with a small adapter
   * that encodes outgoing plain-object messages to transferable `Uint8Array`
   * when possible and decodes incoming binary messages back to objects.
   * It also wires cross-platform event handlers (`message`, `error`,
   * `messageerror`) and returns the `WorkerObj` metadata entry used by the pool.
   *
   * @private
   * @param {number} [id] - Optional explicit id for the worker entry.
   * @returns {WorkerObj} The newly created worker entry.
   */
  _addWorkerInstance(id) {
    if (id == null) id = this._nextWorkerId++;
    const underlying = this._createWorkerInstance();

    const worker = new WorkerWrapper(underlying, this._logger, this);

    const workerObj = {
      id,
      worker,
      tasks: 0,
      lastActive: nowMs(),
      latencyEwma: null,
      _startTimes: new PowerQueue(),
    };
    // track completed tasks per worker (for termination-time averages)
    workerObj.completedTasks = 0;
    this.workers.push(workerObj);
    this._totalWorkersCreated++;
    this._bus.emit('pool:scale', {
      action: 'add',
      id: workerObj.id,
      minSize: this.minSize,
      maxSize: this.maxSize,
    });
    // register underlying -> workerObj mapping so shared handlers can locate metadata
    try {
      this._underlyingToWorkerObj.set(underlying, workerObj);
    } catch (e) {
      /* ignore mapping failures */
    }

    // pool-level handler: decrements tasks, dispatches queued work and
    // forwards messages to pool listeners. This is assigned on the
    // wrapper `worker` so the underlying worker can forward a decoded
    // event into it.
    worker.onmessage = (e) => {
      const now = nowMs();
      workerObj.tasks = Math.max(0, workerObj.tasks - 1);
      // decrement global active task count for the completed task
      this._decrementActiveTasks(1);
      workerObj.lastActive = now;

      // If the worker's response carries a correlationId, resolve any pending Promise.
      try {
        const data = e?.data;
        if (data && typeof data === 'object' && data.correlationId != null) {
          const pid = String(data.correlationId);
          const resp = Object.prototype.hasOwnProperty.call(data, 'response')
            ? data.response
            : data;
          this._cleanupPendingResponse(pid, { resolveWith: resp });
        }
      } catch (err) {
        this._debugLog?.(err, 'worker.onmessage: resolve pending response');
      }

      // Update EWMA latency using the oldest start timestamp for this worker if present
      try {
        const start = workerObj._startTimes?.length ? workerObj._startTimes.shift() : null;
        // Prefer worker-reported processing duration when available (worker may measure its own CPU time),
        // otherwise fall back to wall-clock latency computed from the recorded start time.
        let x = null;
        try {
          const data = e?.data;
          if (typeof data?.duration === 'number' && Number.isFinite(data.duration)) {
            x = Math.max(0, Number(data.duration));
          } else if (start != null) {
            x = Math.max(0, now - start);
          }

          if (x != null) {
            // smoothing factor for per-worker EWMA; allow pool-level alpha when configured
            const alpha = this._autoScale?.alpha || 0.2;
            if (workerObj.latencyEwma == null) workerObj.latencyEwma = x;
            else workerObj.latencyEwma = alpha * x + (1 - alpha) * workerObj.latencyEwma;

            // update pool-level EWMA (aggregate) for autoscaling decisions
            if (this._ewmaLatency == null) this._ewmaLatency = x;
            else this._ewmaLatency = alpha * x + (1 - alpha) * this._ewmaLatency;

            // record pool-level performance metrics using worker-observed or computed task time
            // Update counts and Welford streaming stats (O(1) memory/time)
            this._totalTasksCompleted = (this._totalTasksCompleted || 0) + 1;
            workerObj.completedTasks = (workerObj.completedTasks || 0) + 1;
            const k = 1; // single sample
            const prevCount = this._taskDurationsWelfordCount;
            this._taskDurationsWelfordCount = prevCount + k;
            const delta = x - this._taskDurationsWelfordMean;
            this._taskDurationsWelfordMean += (delta * k) / this._taskDurationsWelfordCount;
            const delta2 = x - this._taskDurationsWelfordMean;
            this._taskDurationsWelfordM2 += delta * delta2;
            if (x < this._taskDurationsMin) this._taskDurationsMin = x;
            if (x > this._taskDurationsMax) this._taskDurationsMax = x;
          }
        } catch (err) {
          this._debugLog?.(err, 'worker.onmessage: latency tracking inner');
        }
      } catch (err) {
        this._debugLog?.(err, 'worker.onmessage: latency tracking outer');
      }

      // dispatch queued task if any, unless queue dispatch is paused for backpressure control
      if (
        !this._queuePaused &&
        this.queue.length > 0 &&
        workerObj.tasks < this._maxTasksPerWorker
      ) {
        const item = this.queue.shift();
        try {
          if (item.transfer) worker.postMessage(item.message, item.transfer);
          else worker.postMessage(item.message);
          workerObj._startTimes.push(now);
          workerObj.tasks++;
          this._activeTasks++;
        } catch (err) {
          this._debugLog?.(err, 'dispatch queued message to worker failed');
          this._logger.error(err, 'Failed to dispatch queued message to worker');
        }
        // after removing one queued item, if we dropped below threshold clear the crossed flag
        if (this._queueHighCrossed && this.queue.length <= this._queueHighThreshold) {
          this._queueHighCrossed = false;
        }
      }

      if (this._onmessage) {
        try {
          this._onmessage(e);
        } catch (err) {
          this._logger.error(err, 'Pool onmessage handler error');
        }
      }
      this._bus.emit('message', e);

      // update idle state after processing a message (and possibly dispatching queued tasks)
      this._updateIdleState();
    };

    /**
     * Autoscale tick: simple policy that grows/shrinks by one worker based on
     * pool-level EWMA latency and queue pressure. Runs only when `autoScale`
     * is configured on the pool.
     *
     * - scale up: when EWMA > targetMs OR queue length exceeds worker count
     * - scale down: when EWMA < targetMs * 0.5 AND queue is empty
     */
    // moved to prototype method: _autoScaleTick()

    // forward underlying events, decoding binary payloads to JS objects
    /**
     * Handle a raw message event from the underlying Worker and decode
     * binary payloads back to JS values before forwarding to the wrapper
     * `worker.onmessage` handler.
     *
     * @private
     * @param {MessageEvent|any} e - The raw event or message payload.
     */
    const _handleMessage = (e) => {
      // support both browser-like MessageEvent (with .data) and Node 'message' callbacks (data passed directly)
      let data = e?.data !== undefined ? e.data : e;
      let decoded = data;
      if (data && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
        try {
          decoded = u82o(data);
        } catch (err) {
          try {
            _handleMessageError(err);
          } catch (ee) {
            this._debugLog?.(ee, '_handleMessage: _handleMessageError failed');
          }
          decoded = data;
        }
      }
      const ev =
        e?.data !== undefined && decoded === data ? e : { data: decoded, originalEvent: e };
      if (typeof worker.onmessage === 'function') {
        try {
          worker.onmessage(ev);
        } catch (err) {
          this._logger.error(err, 'worker wrapper onmessage error');
        }
      }
    };

    /**
     * Handle an error event from the underlying Worker and forward it to
     * the wrapper `worker.onerror` and pool-level error listeners.
     *
     * @private
     * @param {any} e - The error event or value.
     */
    const _handleError = (e) => {
      if (typeof worker.onerror === 'function') {
        try {
          worker.onerror(e);
        } catch (err) {
          this._logger.error(err, 'worker wrapper onerror error');
        }
      }
      this._bus.emit('error', e);
    };

    /**
     * Handle a `messageerror` event from the underlying Worker and forward
     * it to the wrapper `worker.onmessageerror` and pool-level listeners.
     *
     * @private
     * @param {any} e - The messageerror event or value.
     */
    const _handleMessageError = (e) => {
      if (typeof worker.onmessageerror === 'function') {
        try {
          worker.onmessageerror(e);
        } catch (err) {
          this._logger.error(err, 'worker wrapper onmessageerror error');
        }
      }
      this._bus.emit('messageerror', e);
    };

    // Attach handlers in a cross-platform way (Worker in browsers and Node.js worker_threads)
    if (typeof underlying.addEventListener === 'function') {
      try {
        underlying.addEventListener('message', _handleMessage);
      } catch (e) {
        this._debugLog?.(e, 'attach addEventListener message');
      }
      try {
        underlying.addEventListener('error', _handleError);
      } catch (e) {
        this._debugLog?.(e, 'attach addEventListener error');
      }
      try {
        underlying.addEventListener('messageerror', _handleMessageError);
      } catch (e) {
        this._debugLog?.(e, 'attach addEventListener messageerror');
      }
    } else if (typeof underlying.on === 'function') {
      try {
        underlying.on('message', _handleMessage);
      } catch (e) {
        this._debugLog?.(e, 'attach underlying.on message');
      }
      try {
        underlying.on('error', _handleError);
      } catch (e) {
        this._debugLog?.(e, 'attach underlying.on error');
      }
      try {
        underlying.on('messageerror', _handleMessageError);
      } catch (e) {
        this._debugLog?.(e, 'attach underlying.on messageerror');
      }
    } else {
      // last-resort assignments
      try {
        underlying.onmessage = _handleMessage;
      } catch (e) {
        this._debugLog?.(e, 'assign underlying.onmessage');
      }
      try {
        underlying.onerror = _handleError;
      } catch (e) {
        this._debugLog?.(e, 'assign underlying.onerror');
      }
      try {
        underlying.onmessageerror = _handleMessageError;
      } catch (e) {
        this._debugLog?.(e, 'assign underlying.onmessageerror');
      }
    }

    return workerObj;
  }

  /**
   * Return the least-loaded worker (smallest `tasks` count).
   *
   * When multiple workers share the same `tasks` count prefer the one with
   * the lower EWMA latency (`latencyEwma`). Returns `null` when no workers
   * are available.
   *
   * @private
   * @returns {WorkerObj|null}
   */
  _findLeastLoadedWorker() {
    if (!this.workers.length) return null;
    let best = null;
    let bestTasks = Infinity;
    let bestLat = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.workers.length; i++) {
      const w = this.workers[i];
      const lat = w.latencyEwma != null ? w.latencyEwma : Number.POSITIVE_INFINITY;
      if (w.tasks < bestTasks || (w.tasks === bestTasks && lat < bestLat)) {
        best = w;
        bestTasks = w.tasks;
        bestLat = lat;
      }
    }
    return best;
  }

  /**
   * Determine whether a single-worker pool should queue rather than flood the
   * underlying worker with additional in-flight messages.
   * @private
   * @param {WorkerObj|null} least
   * @param {number|null} targetWorkerId
   * @returns {boolean}
   */
  /**
   * Post a message to a worker in the pool.
   * The pool will try to reuse an idle/least-loaded worker, grow the pool
   * (up to `maxSize`), or queue the task if configured.
   *
   * @param {*} message - The message to post to a worker.
   * @param {Transferable[]=} transfer - Optional transfer list. If omitted and
   * a plain JS object is supplied, the pool will internally encode the object
   * to a transferable `Uint8Array` (via `o2u8`) and pass its `ArrayBuffer` as
   * the transfer list to avoid structured-clone copies.
   * @param {PostMessageOptions=} options - Optional flags controlling behavior such as `awaitResponse`, `timeout`, `workerId`, and `zeroCopy`.
   * @returns {boolean|Promise<any>} When `options.awaitResponse` is truthy this returns a `Promise` that resolves with the worker response; otherwise returns `true` when the message was accepted (dispatched or queued) or `false` when it was rejected.
   * @throws {Error} When `options.awaitResponse` is used but the provided `message` is not a plain object.
   */
  postMessage(message, transfer, options) {
    // support optional third-argument `options` for Promise-based responses
    options = options || undefined;
    // capture a single timestamp for this dispatch to avoid multiple syscalls
    const now = nowMs();
    // support explicit per-worker targeting via `options.workerId`
    const targetWorkerId = options?.workerId != null ? options.workerId : null;
    const singleWorkerDirectFastPath =
      targetWorkerId == null && this.workers.length === 1 && this._maxTasksPerWorker === Infinity;
    // prefer an existing idle/least-loaded worker
    const least =
      targetWorkerId != null
        ? this.workers.find((w) => w.id === targetWorkerId)
        : singleWorkerDirectFastPath
          ? this.workers[0]
          : this._findLeastLoadedWorker();

    // support awaiting a response: options.awaitResponse or explicit options.correlationId
    const wantResponse = Boolean(options?.awaitResponse || options?.correlationId != null);
    let correlationId;
    let pendingPromise;
    if (wantResponse) {
      // Bound the correlation id to 32 bits to avoid unbounded integer growth
      // in extremely long-lived pools. Use unsigned 32-bit wrap-around.
      correlationId =
        options.correlationId != null
          ? String(options.correlationId)
          : this._generateCorrelationId();
      // only plain-object messages can be augmented with correlationId
      const isPlainObject =
        message !== null &&
        typeof message === 'object' &&
        !ArrayBuffer.isView(message) &&
        !(message instanceof ArrayBuffer);
      if (!isPlainObject) {
        throw new Error('postMessage awaitResponse requires a plain-object message');
      }
      // attach correlation id to the outgoing message
      // (workers should echo this field back in their response)
      message = Object.assign({}, message, { correlationId });

      const created = this._createPendingResponsePromise(correlationId, options);
      pendingPromise = created.pendingPromise;
      correlationId = created.correlationKey;
    }

    // (moved to class method `_prepareForTransfer`) use that instead

    if (least?.tasks < this._maxTasksPerWorker) {
      try {
        const startTime = now;
        const prepared = this._prepareForTransfer(message, transfer, options);
        return this._postToWorkerObj(
          least,
          prepared,
          startTime,
          wantResponse,
          correlationId,
          pendingPromise
        );
      } catch (err) {
        if (wantResponse && correlationId) {
          try {
            this._cleanupPendingResponse(correlationId, { rejectWith: err });
          } catch (e) {
            this._debugLog?.(e, 'postMessage: cleanupPendingResponse failed');
          }
          try {
            this._logger.error(err, 'Failed to postMessage to worker');
          } catch (e) {
            this._debugLog?.(e, 'postMessage: logger.error failed');
          }
          return pendingPromise;
        }
        try {
          this._logger.error(err, 'Failed to postMessage to worker');
        } catch (e) {
          this._debugLog?.(e, 'postMessage: logger.error failed');
        }
        return false;
      }
    }

    // If a specific workerId was requested but we didn't dispatch above,
    // fail fast: the targeted worker is missing or at capacity.
    if (targetWorkerId != null && (!least || least.tasks >= this._maxTasksPerWorker)) {
      if (wantResponse && correlationId) {
        try {
          this._cleanupPendingResponse(correlationId, {
            rejectWith: new Error('targeted worker unavailable'),
          });
        } catch (e) {
          this._debugLog?.(e, 'postMessage: cleanupPendingResponse failed');
        }
        return pendingPromise;
      }
      return false;
    }

    // if we can grow the pool, create a new worker and use it
    // If a specific workerId was requested, do not auto-grow the pool to satisfy it
    if (targetWorkerId == null && this.workers.length < this.maxSize) {
      const startTime = now;
      return this._tryGrowPool(
        message,
        transfer,
        options,
        startTime,
        wantResponse,
        correlationId,
        pendingPromise
      );
    }

    // pool full and all workers at capacity (or targeted worker busy/missing)
    if (this.taskQueueEnabled) {
      const prepared = this._prepareForTransfer(message, transfer, options);
      return this._enqueueOrReject(prepared, wantResponse, correlationId, pendingPromise);
    }

    // fallback: round-robin dispatch. Use modulo to keep `_nextIndex` bounded
    if (!this.workers.length) return wantResponse ? pendingPromise : false;
    const idx = this._nextIndex % this.workers.length;
    // advance and wrap to avoid unbounded integer growth
    this._nextIndex = (this._nextIndex + 1) % this.workers.length;
    const fallback = this.workers[idx];
    try {
      const startTime = now;
      const prepared = this._prepareForTransfer(message, transfer);
      return this._postToWorkerObj(
        fallback,
        prepared,
        startTime,
        wantResponse,
        correlationId,
        pendingPromise
      );
    } catch (err) {
      if (wantResponse && correlationId) {
        try {
          this._cleanupPendingResponse(correlationId, { rejectWith: err });
        } catch (e) {
          this._debugLog?.(e, 'postMessage: cleanupPendingResponse failed');
        }
        try {
          this._logger.error(err, 'Failed to postMessage to fallback worker');
        } catch (e) {
          this._debugLog?.(e, 'postMessage: logger.error failed');
        }
        return pendingPromise;
      }
      try {
        this._logger.error(err, 'Failed to postMessage to fallback worker');
      } catch (e) {
        this._debugLog?.(e, 'postMessage: logger.error failed');
      }
      return false;
    }
  }

  /**
   * Generate a safe correlation id. Prefer `crypto.randomUUID()` when
   * available, otherwise fall back to a timestamp + random suffix.
   * @private
   * @returns {string}
   */
  _generateCorrelationId() {
    // Prefer standard Web Crypto `randomUUID` when available and append
    // a monotonic counter to guarantee uniqueness within this pool instance.
    try {
      const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
      if (typeof cryptoObj?.randomUUID === 'function') {
        return String(`${cryptoObj.randomUUID()}-${this._correlationCounter++}`);
      }
    } catch (e) {
      // ignore and fall back
    }

    // Fallback: WebCrypto `getRandomValues` if available, append counter
    try {
      const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
      if (typeof cryptoObj?.getRandomValues === 'function') {
        const arr = new Uint8Array(16);
        cryptoObj.getRandomValues(arr);
        const hex = Array.from(arr)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        return String(`${hex}-${this._correlationCounter++}`);
      }
    } catch (e) {
      // ignore
    }

    // Last-resort fallback: timestamp + Math.random + counter
    const rand = Math.floor(Math.random() * 0xffffffff).toString(16);
    return String(`cid-${Math.floor(nowMs()).toString(36)}-${rand}-${this._correlationCounter++}`);
  }

  /**
   * Centralized cleanup for a pending response entry.
   * Ensures the timer is cleared and the entry is resolved/rejected exactly once.
   * @private
   * @param {string|number} key
   * @param {{resolveWith?:any, rejectWith?:any}} opts
   */
  _cleanupPendingResponse(key, opts = {}) {
    const k = key != null ? String(key) : key;
    const entry = this._pendingResponses.get(k);
    if (!entry) return false;
    try {
      if (entry.timer) {
        try {
          clearTimeout(entry.timer);
        } catch (e) {
          this._debugLog?.(e, '_cleanupPendingResponse: clearTimeout failed');
        }
      }
    } catch (e) {
      this._debugLog?.(e, '_cleanupPendingResponse: timer check failed');
    }
    try {
      if (Object.prototype.hasOwnProperty.call(opts, 'resolveWith'))
        entry.resolve(opts.resolveWith);
      else if (Object.prototype.hasOwnProperty.call(opts, 'rejectWith'))
        entry.reject(opts.rejectWith);
    } catch (e) {
      this._debugLog?.(e, '_cleanupPendingResponse: resolve/reject failed');
    } finally {
      try {
        this._pendingResponses.delete(k);
      } catch (e) {
        this._debugLog?.(e, '_cleanupPendingResponse: delete failed');
      }
    }
    return true;
  }

  /**
   * Broadcasts a message to all workers in the pool.
   * @param {*} message
   * @param {Transferable[]=} transfer - Optional transfer list. If omitted and a
   * plain JS object is supplied, the pool will attempt to encode the object for
   * each worker into a transferable `Uint8Array` (via `o2u8`) so each worker
   * receives an independent transferable buffer to avoid structured-clone copies.
   * @returns {void}
   */
  broadcast(message, transfer) {
    // Snapshot the time once for this broadcast to avoid multiple syscalls
    // and to keep `lastActive` consistent across all workers in this broadcast.
    const now = nowMs();
    // If a plain object and no transfer supplied, encode once and reuse the encoded
    // payload for each worker (slice per-worker to create transferable buffers).
    let sharedU8 = null;
    const isPlainObject =
      message !== null &&
      typeof message === 'object' &&
      !ArrayBuffer.isView(message) &&
      !(message instanceof ArrayBuffer);
    for (const w of this.workers) {
      try {
        let msg = message;
        let tr = transfer;
        if (!tr && isPlainObject) {
          try {
            if (sharedU8 == null) sharedU8 = this._encodeForTransfer(message);
            // create a per-worker copy of the encoded data (slice creates a new ArrayBuffer)
            const copy = sharedU8.slice();
            msg = copy;
            tr = [copy.buffer];
          } catch (err) {
            msg = message;
            tr = undefined;
          }
        }
        if (tr?.length) w.worker.postMessage(msg, tr);
        else w.worker.postMessage(msg);
        // record start time for latency tracking (use same timestamp for all records in this iteration)
        if (typeof w._startTimes?.push === 'function') w._startTimes.push(now);
        w.tasks++;
        this._activeTasks++;
        w.lastActive = now;
      } catch (err) {
        this._logger.error(err, 'broadcast error');
      }
    }
    this._updateIdleState();
  }

  /**
   * Normalize stop-the-press options and strip internal-only flags.
   * @private
   * @param {Object=} options
   * @returns {{recreate: boolean, fwdOptions: Object|undefined}}
   */
  _normalizeStopThePressOptions(options) {
    const recreate =
      typeof options?.recreateWorkers !== 'undefined' ? Boolean(options.recreateWorkers) : true;
    const fwdOptions = typeof options === 'object' ? Object.assign({}, options) : undefined;
    if (fwdOptions) delete fwdOptions.recreateWorkers;
    return { recreate, fwdOptions };
  }

  /**
   * Shared reset routine used by stop-the-press APIs.
   * Clears queue and pending responses, terminates workers, optionally recreates workers,
   * and updates idle state.
   * @private
   * @param {{recreate:boolean, scope:string}} config
   * @returns {{currentCount:number, terminatedIds:number[]}}
   */
  _resetPoolForStopThePress({ recreate, scope }) {
    try {
      if (typeof this.queue?.clear === 'function') this.queue.clear();
    } catch (err) {
      this._logger.error(err, `${scope}: failed to clear queue`);
    }
    // Reset queue high-watermark state when queue is cleared to avoid stale flags
    try {
      this._queueHighCrossed = false;
    } catch (e) {
      this._debugLog?.(e, '_resetPoolForStopThePress: queueHighCrossed reset failed');
    }

    try {
      for (const [cid] of this._pendingResponses) {
        try {
          this._cleanupPendingResponse(cid, {
            rejectWith: new Error(`${scope}: cancelled pending response`),
          });
        } catch (e) {
          this._debugLog?.(e, '_resetPoolForStopThePress: cleanupPendingResponse failed');
        }
      }
    } catch (err) {
      this._logger.error(err, `${scope}: failed to cancel pending responses`);
    }

    let currentCount = 0;
    let workersList = [];
    try {
      const workersRef = this.workers;
      currentCount = Number(workersRef?.length) || 0;
      if (Array.isArray(workersRef)) {
        workersList = workersRef.slice();
      } else {
        workersList = new Array(currentCount);
        for (let i = 0; i < currentCount; i++) workersList[i] = workersRef[i];
      }
    } catch (err) {
      this._logger.error(err, `${scope}: failed to snapshot workers`);
      currentCount = 0;
      workersList = [];
    }
    const terminatedIds = workersList.map((w) => w?.id).filter((x) => x != null);
    try {
      for (let i = workersList.length - 1; i >= 0; i--) {
        const w = workersList[i];
        this._terminatedWorkerTaskCountsTotal += w.completedTasks || 0;
        this._terminatedWorkerTaskCountsCount += 1;
        try {
          w.worker.terminate();
        } catch (e) {
          this._debugLog?.(e, '_resetPoolForStopThePress: worker.terminate failed');
        }
        this._deleteWorkerUnderlyingMapping(w);
      }
      this.workers.length = 0;
      this._activeTasks = 0;
    } catch (err) {
      this._logger.error(err, `${scope}: failed while terminating workers`);
    }

    if (!recreate) {
      this._clearLifecycleIntervals();
    }

    if (recreate) {
      const desired = Math.max(this.minSize, Math.min(currentCount, this.maxSize));
      for (let i = 0; i < desired; i++) {
        try {
          const before = this.workers.length;
          this._addWorkerInstance();
          if (this.workers.length === before) break;
        } catch (err) {
          try {
            this._logger.error(err, 'recreate: add worker failed');
          } catch (e) {
            this._debugLog?.(e, 'recreate: logger.error failed');
          }
          try {
            this._bus.emit('pool:error', { phase: 'recreate', error: err });
          } catch (e) {
            this._debugLog?.(e, 'recreate: bus.emit failed');
          }
          break;
        }
      }
      try {
        this._ensureReaper();
      } catch (e) {
        this._debugLog?.(e, 'recreate: ensureReaper failed');
      }
    }

    this._updateIdleState();
    return { currentCount, terminatedIds };
  }

  /**
   * Stop all pending queued tasks and immediately post a message to the pool.
   * This clears the internal task queue first (cancelling pending tasks),
   * updates the pool idle state, then forwards the provided message using
   * `postMessage` so the message is dispatched to a live worker immediately
   * (or enqueued if no worker can accept it).
   *
   * @param {*} message - The message to post after clearing pending tasks.
   * @param {Transferable[]=} transfer - Optional transfer list. When omitted
   * and a plain object is supplied, the pool will attempt to encode the
   * object to a transferable `Uint8Array` for efficient transfer.
   * @param {Object=} options - Optional options forwarded to `postMessage`.
   * @returns {boolean|Promise<any>} The same return value as `postMessage`.
   */
  stopThePress(message, transfer, options) {
    const { recreate, fwdOptions } = this._normalizeStopThePressOptions(options);
    const { currentCount, terminatedIds } = this._resetPoolForStopThePress({
      recreate,
      scope: 'stopThePress',
    });

    // emit pool:scale for the mass-termination (if any)
    try {
      if (terminatedIds?.length) {
        this._bus.emit('pool:scale', {
          action: 'remove',
          terminated: terminatedIds,
          count: currentCount,
        });
      }
    } catch (e) {
      this._logger.error(e, 'pool scale stopThePress listener error');
    }

    // 4) finally forward the provided message using normal dispatch
    return this.postMessage(message, transfer, fwdOptions);
  }

  /**
   * Post a batch of messages to the pool.
   * Each entry is an object: `{ message, transfer? }`.
   * Returns an array with the same length as `items` where each element is
   * either a boolean (accepted) or a Promise (when `options.awaitResponse` is used).
   * @param {{message:*,transfer?:Transferable[]}[]} items
   * @param {Object=} options - Optional options forwarded to each `postMessage` call.
   * @returns {(boolean|Promise<any>)[]}
   * @throws {Error} When `items` is not an array.
   */
  postMessageBatch(items, options) {
    if (!Array.isArray(items))
      throw new Error('postMessageBatch expects an array of {message, transfer?}');

    // If the caller expects per-item responses (awaitResponse or explicit correlationId),
    // defer to the single-item `postMessage` implementation so correlation ids and
    // pending Promises are handled exactly the same way for each item.
    const wantsResponse = Boolean(options?.awaitResponse || options?.correlationId != null);
    const correlationIdFactory =
      typeof options?.correlationIdFactory === 'function' ? options.correlationIdFactory : null;
    if (wantsResponse) {
      if (options?.correlationId != null && items.length > 1 && !correlationIdFactory) {
        throw new Error(
          'postMessageBatch cannot use a fixed correlationId for multiple items; provide options.correlationIdFactory or omit correlationId'
        );
      }
      const results = new Array(items.length);
      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        const perItemOptions = Object.assign({}, options);
        if (correlationIdFactory) {
          perItemOptions.correlationId = String(correlationIdFactory(i, it));
        }
        results[i] = this.postMessage(it.message, it.transfer, perItemOptions);
      }
      return results;
    }

    // Optimized path for fire-and-forget batches (no per-item Promise handling):
    // - prepare transferable buffers once per item (avoid repeated structured-clone attempts)
    // - attempt direct dispatch to available workers
    // - collect any prepared items that must be queued and push them into the queue
    const results = new Array(items.length);
    const queuedPrepared = [];
    const targetWorkerId = options?.workerId != null ? options.workerId : null;

    const preparedItems = this.prepareBuffers(items, {
      clone: true,
      zeroCopy: Boolean(options?.zeroCopy),
    });

    // Single-worker opt-in fast path: avoid repeated worker selection and
    // queueing overhead when there is only one worker and it can accept
    // unlimited tasks via the native worker queue.
    if (
      targetWorkerId == null &&
      this.workers.length === 1 &&
      this._maxTasksPerWorker === Infinity
    ) {
      const obj = this.workers[0];
      let idleStateDirty = false;
      for (let i = 0; i < items.length; i++) {
        const prepared = preparedItems[i] || {
          message: items[i]?.message,
          transfer: items[i]?.transfer,
        };
        try {
          const startTime = nowMs();
          if (prepared.transfer?.length)
            obj.worker.postMessage(prepared.message, prepared.transfer);
          else obj.worker.postMessage(prepared.message);
          if (typeof obj._startTimes?.push === 'function') obj._startTimes.push(startTime);
          obj.tasks++;
          this._activeTasks++;
          obj.lastActive = startTime;
          idleStateDirty = true;
          results[i] = true;
        } catch (err) {
          results[i] = false;
        }
      }
      if (idleStateDirty) this._updateIdleState();
      return results;
    }

    const isTargeted = targetWorkerId != null;
    let chosen = null;
    if (isTargeted) {
      chosen = this.workers.find((w) => w.id === targetWorkerId);
      if (!chosen) return items.map(() => false);
    } else {
      chosen = this._findLeastLoadedWorker();
    }
    let idleStateDirty = false;

    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const prepared = preparedItems[i] || { message: it.message, transfer: it.transfer };
      let dispatched = false;

      // If chosen worker is saturated, clear it so we re-select on demand
      if (chosen?.tasks >= this._maxTasksPerWorker) chosen = null;

      // try to reuse the same worker choice until it becomes saturated
      let least = chosen;
      if (!least && !isTargeted) least = this._findLeastLoadedWorker();

      if (least?.tasks < this._maxTasksPerWorker) {
        try {
          const startTime = nowMs();
          if (prepared.transfer?.length)
            least.worker.postMessage(prepared.message, prepared.transfer);
          else least.worker.postMessage(prepared.message);
          if (typeof least._startTimes?.push === 'function') least._startTimes.push(startTime);
          least.tasks++;
          this._activeTasks++;
          least.lastActive = startTime;
          idleStateDirty = true;
          results[i] = true;
          dispatched = true;
          // keep using this worker until it becomes saturated
          chosen = least.tasks < this._maxTasksPerWorker ? least : null;
        } catch (err) {
          results[i] = false;
          dispatched = true;
        }
      }

      if (!dispatched) {
        // If we can grow the pool (and no specific workerId was requested), create a new worker and use it
        if (targetWorkerId == null && this.workers.length < this.maxSize) {
          try {
            const obj = this._addWorkerInstance();
            if (!obj) {
              results[i] = false;
              dispatched = true;
            } else {
              const startTime = nowMs();
              if (prepared.transfer?.length)
                obj.worker.postMessage(prepared.message, prepared.transfer);
              else obj.worker.postMessage(prepared.message);
              if (typeof obj._startTimes?.push === 'function') obj._startTimes.push(startTime);
              obj.tasks++;
              this._activeTasks++;
              obj.lastActive = startTime;
              idleStateDirty = true;
              results[i] = true;
              dispatched = true;
              // prefer using the newly-created worker for next items
              chosen = obj.tasks < this._maxTasksPerWorker ? obj : null;
            }
          } catch (err) {
            try {
              this._logger.error(err, 'postMessageBatch: add worker failed');
            } catch (e) {}
            try {
              this._bus.emit('pool:error', { phase: 'postMessageBatch', error: err });
            } catch (e) {}
            results[i] = false;
            dispatched = true;
          }
        }
      }

      if (!dispatched) {
        if (targetWorkerId != null) {
          // targeted worker semantics are fail-fast when busy or missing
          results[i] = false;
          continue;
        }

        // Pool is saturated: collect for queueing or fallback
        if (this.taskQueueEnabled) {
          const policy = this._queuePolicy;
          if (policy === 'reject' || (policy === 'drop-newest' && this.queue.length > 0)) {
            results[i] = false;
          } else {
            if (policy === 'drop-oldest' && this.queue.length > 0) {
              const dropped = this.queue.shift();
              if (dropped?.correlationId != null) {
                this._cleanupPendingResponse(dropped.correlationId, {
                  rejectWith: new Error('postMessage queued task dropped by policy'),
                });
              }
            }
            queuedPrepared.push({ message: prepared.message, transfer: prepared.transfer });
            results[i] = true;
          }
        } else {
          // fallback round-robin
          if (!this.workers.length) {
            results[i] = false;
          } else {
            const idx = this._nextIndex % this.workers.length;
            this._nextIndex = (this._nextIndex + 1) % this.workers.length;
            const fallback = this.workers[idx];
            try {
              const startTime = nowMs();
              if (prepared.transfer?.length)
                fallback.worker.postMessage(prepared.message, prepared.transfer);
              else fallback.worker.postMessage(prepared.message);
              if (typeof fallback._startTimes?.push === 'function')
                fallback._startTimes.push(startTime);
              fallback.tasks++;
              this._activeTasks++;
              fallback.lastActive = startTime;
              idleStateDirty = true;
              results[i] = true;
            } catch (err) {
              results[i] = false;
              this._logger.error(err, 'Failed to postMessage to fallback worker');
            }
          }
        }
      }
    }

    // Push queued items into the queue using batch enqueue for efficiency
    if (queuedPrepared.length) {
      try {
        // queue stores plain objects `{message,transfer}` so we can pass the array directly
        this.queue.pushMany(queuedPrepared);
        idleStateDirty = true;
        // emit queue high-watermark event when threshold crossed (avoid spamming)
        try {
          if (
            Number.isFinite(this._queueHighThreshold) &&
            this.queue.length > this._queueHighThreshold &&
            !this._queueHighCrossed
          ) {
            this._queueHighCrossed = true;
            this._bus.emit('pool:queue:high', {
              length: this.queue.length,
              threshold: this._queueHighThreshold,
            });
          }
        } catch (e) {
          this._debugLog?.(e, 'postMessageBatch: bus.emit pool:queue:high failed');
        }
      } catch (err) {
        this._logger.error(err, 'postMessageBatch: failed to enqueue prepared items');
      }
    }

    // Update idle state once for the whole batch if anything changed
    if (idleStateDirty) this._updateIdleState();

    return results;
  }

  /**
   * Stop the press and then post a batch of messages.
   *
   * Clears the internal task queue and terminates inflight workers (optionally recreating them),
   * rejects pending response Promises, then forwards the provided batch to `postMessageBatch`.
   *
   * This method mirrors the semantics of `stopThePress` for single messages but
   * operates on a batch. Use it when you need to atomically cancel pending work
   * and then seed the pool with a new set of tasks.
   *
   * @param {{message:*,transfer?:Transferable[]}[]} items - Array of items to send after clearing the pool.
   * @param {Object=} options - Optional options forwarded to `postMessageBatch`.
   *   Recognized options include:
   *     - `recreateWorkers` (boolean, default: true) — whether to recreate replacement workers after termination.
   *     - `awaitResponse` (boolean) — if true, returned slots will be Promises as in `postMessageBatch`.
   *     - `workerId` (number) — target a specific worker during dispatch attempts.
   * @returns {(boolean|Promise<any>)[]} Array with per-item results: `true|false` or `Promise` when awaiting responses.
   */
  stopThePressBatch(items, options) {
    const { recreate, fwdOptions } = this._normalizeStopThePressOptions(options);
    this._resetPoolForStopThePress({ recreate, scope: 'stopThePressBatch' });

    try {
      return this.postMessageBatch(items, fwdOptions);
    } catch (err) {
      try {
        this._logger.error(err, 'stopThePressBatch: postMessageBatch failed');
      } catch (e) {
        this._debugLog?.(e, 'stopThePressBatch: logger.error failed');
      }
      // return an array of `false` to indicate none dispatched
      try {
        return new Array(items ? items.length : 0).fill(false);
      } catch (e) {
        return [];
      }
    }
  }

  /**
   * Add one worker to the pool immediately.
   * @returns {WorkerObj} The newly created worker entry.
   */
  addWorker() {
    try {
      return this._addWorkerInstance();
    } catch (err) {
      try {
        this._logger.error(err, 'addWorker: failed');
      } catch (e) {
        this._debugLog?.(e, 'addWorker: logger.error failed');
      }
      try {
        this._bus.emit('pool:error', { phase: 'addWorker', error: err });
      } catch (e) {
        this._debugLog?.(e, 'addWorker: bus.emit failed');
      }
      return null;
    }
  }

  /**
   * Remove the last worker from the pool and terminate it.
   * @returns {void}
   */
  removeWorker() {
    const w = this.workers.pop();
    if (w) {
      // adjust global active task counter if worker had inflight tasks
      this._decrementActiveTasks(w.tasks || 0);
      try {
        w.worker.terminate();
      } catch (err) {
        this._debugLog?.(err, 'removeWorker: worker.terminate failed');
      }
      this._deleteWorkerUnderlyingMapping(w);
      this._terminatedWorkerTaskCountsTotal += w.completedTasks || 0;
      this._terminatedWorkerTaskCountsCount += 1;
    }
  }

  /**
   * Internal: terminate workers that have been idle longer than `idleTimeout`.
   * Keeps at least `minSize` workers alive.
   *
   * This routine scans workers from newest to oldest and terminates those
   * which have had no tasks for longer than `idleTimeout`, updating
   * termination statistics used by `getStats()`.
   *
   * @private
   * @returns {void}
   */
  _reapIdleWorkers() {
    if (this.idleTimeout <= 0) return;
    const now = nowMs();
    // keep at least minSize workers
    for (let i = this.workers.length - 1; i >= 0; i--) {
      const w = this.workers[i];
      if (this.workers.length <= this.minSize) break;
      if (w.tasks === 0 && now - (w.lastActive || 0) > this.idleTimeout) {
        try {
          w.worker.terminate();
        } catch (err) {
          this._debugLog?.(err, '_reapIdleWorkers: worker.terminate failed');
        }
        try {
          const u = w.worker?._underlying;
          if (u && this._underlyingToWorkerObj) this._underlyingToWorkerObj.delete(u);
        } catch (e) {
          this._debugLog?.(e, '_reapIdleWorkers: underlyingToWorkerObj.delete failed');
        }
        // Remove the worker without O(n) splice by swapping with the last
        // element and popping. This keeps removal O(1) and avoids shifting
        // the remaining array entries.
        const lastIndex = this.workers.length - 1;
        if (i === lastIndex) {
          this.workers.pop();
        } else {
          // Move last into position i and pop the tail.
          this.workers[i] = this.workers.pop();
        }
      }
    }
    // re-evaluate idle state after pruning
    this._updateIdleState();
  }

  /**
   * Autoscale tick: simple policy that grows/shrinks by one worker based on
   * pool-level EWMA latency and queue pressure. Runs only when `autoScale`
   * is configured on the pool.
   *
   * - scale up: when EWMA > targetMs OR queue length exceeds worker count
   * - scale down: when EWMA < targetMs * 0.5 AND queue is empty
   * @private
   */
  _autoScaleTick() {
    try {
      if (!this._autoScale || !this._autoScale.enabled) return;
      const now = nowMs();
      const cfg = this._autoScale;

      // reset backoff multiplier if enough time has passed since last scale
      if (
        this._lastAutoScaleAt &&
        cfg.backoffResetMs &&
        now - this._lastAutoScaleAt > cfg.backoffResetMs
      ) {
        this._autoScaleBackoffMultiplier = 1;
      }

      // enforce effective cooldown between scale actions (taking backoff into account)
      const effectiveCooldown = Math.floor(
        (cfg.cooldownMs || 0) * (this._autoScaleBackoffMultiplier || 1)
      );
      if (this._lastAutoScaleAt && now - this._lastAutoScaleAt < effectiveCooldown) return;

      const target = cfg.targetMs;
      const hysteresis = cfg.hysteresis || 0.2;
      const ewma = this._ewmaLatency;
      const workers = this.workers.length;

      // scale-up heuristics: require EWMA to exceed target by hysteresis
      const upThreshold = target * (1 + hysteresis);
      const needScaleUp = ewma != null ? ewma > upThreshold : false;
      const queuePressure = this.queue.length > Math.ceil(workers * (1 + hysteresis));
      if (needScaleUp || queuePressure) {
        if (workers < this.maxSize) {
          try {
            const maxAdd = Math.min(this.maxSize - workers, cfg.stepUp || 1);
            for (let i = 0; i < maxAdd; i++) {
              try {
                const before = this.workers.length;
                this._addWorkerInstance();
                if (this.workers.length === before) break;
              } catch (e) {
                this._debugLog?.(e, 'autoScale: addWorker failed');
                try {
                  this._bus.emit('pool:error', { phase: 'autoScale:add', error: e });
                } catch (ee) {
                  this._debugLog?.(ee, 'autoScale: bus.emit failed');
                }
                break;
              }
            }
            this._lastAutoScaleAt = now;
            // increase backoff multiplier for successive rapid scales
            // Cap the backoff multiplier to avoid unbounded growth.
            this._autoScaleBackoffMultiplier = Math.min(
              (this._autoScaleBackoffMultiplier || 1) * (cfg.backoffFactor || 1),
              cfg.backoffMaxMultiplier || 8
            );
          } catch (e) {
            this._debugLog?.(e, 'autoScale: addWorker failed outer');
          }
        }
        return;
      }

      // scale-down heuristics: require EWMA to be below target by hysteresis
      const downThreshold = target * Math.max(0, 1 - hysteresis);
      const needScaleDown = ewma != null ? ewma < downThreshold : false;
      if (needScaleDown && this.queue.length === 0) {
        if (workers > this.minSize) {
          try {
            const maxRemove = Math.min(workers - this.minSize, cfg.stepDown || 1);
            let removed = 0;
            // Prefer removing idle workers only (tasks === 0). Iterate from newest to oldest.
            for (let idx = this.workers.length - 1; idx >= 0 && removed < maxRemove; idx--) {
              const candidate = this.workers[idx];
              if (!candidate) continue;
              // skip busy workers to avoid losing in-flight tasks
              if (candidate.tasks > 0) continue;
              try {
                candidate.worker.terminate();
              } catch (e) {
                this._debugLog?.(e, 'autoScale: terminate worker');
              }
              this._deleteWorkerUnderlyingMapping(candidate);
              this._terminatedWorkerTaskCountsTotal += candidate.completedTasks || 0;
              this._terminatedWorkerTaskCountsCount += 1;
              // remove candidate by swapping with last element and popping
              const lastIndex = this.workers.length - 1;
              if (idx === lastIndex) {
                this.workers.pop();
              } else {
                this.workers[idx] = this.workers.pop();
              }
              removed++;
            }
            // Only record a scale action when we actually removed workers.
            if (removed > 0) {
              this._lastAutoScaleAt = now;
              // Cap the backoff multiplier to avoid unbounded growth.
              this._autoScaleBackoffMultiplier = Math.min(
                (this._autoScaleBackoffMultiplier || 1) * (cfg.backoffFactor || 1),
                cfg.backoffMaxMultiplier || 8
              );
            }
          } catch (e) {
            this._debugLog?.(e, 'autoScale: remove worker failed');
          }
        }
      }
    } catch (e) {
      this._debugLog?.(e, 'autoScaleTick outer');
    }
  }

  /**
   * Emit the pool-idle synthetic message to `onmessage` and listeners.
   *
   * The emitted event object has the shape: `{ data: { type: 'pool:idle', stats } }` where
   * `stats` is an array with the per-worker snapshot: `{ id, tasks, lastActive }`.
   *
   * Emission semantics:
   * - The event is emitted only when the pool transitions from non-idle to idle
   *   (i.e. the task queue is empty and every worker has `tasks === 0`).
   * - The synthetic event is delivered to `pool.onmessage`, any `'message'` listeners,
   *   as well as to `pool.onidle` and `addEventListener('idle', cb)` listeners.
   * - The event `data.type` is `'pool:idle'` and can be used to distinguish it
   *   from normal worker messages.
   *
   * @private
   * @returns {void}
   */
  _emitIdle() {
    const ev = { data: { type: 'pool:idle', stats: this.getStats() } };
    this._isIdle = true;
    if (this._onmessage) {
      try {
        this._onmessage(ev);
      } catch (err) {
        this._logger.error(err, 'Pool onmessage handler error');
      }
    }
    if (this._onidle) {
      try {
        this._onidle(ev);
      } catch (err) {
        this._logger.error(err, 'Pool onidle handler error');
      }
    }
    try {
      this._bus.emit('message', ev);
    } catch (err) {
      this._logger.error(err, 'pool listener error');
    }
    try {
      this._bus.emit('idle', ev);
    } catch (err) {
      this._logger.error(err, 'pool idle listener error');
    }
  }

  /**
   * Check current state and emit idle event if transitioning to idle.
   *
   * This function examines active task counts and queue length to detect a
   * transition from non-idle to idle and will call `_emitIdle()` exactly once
   * on such transitions.
   *
   * @private
   * @returns {void}
   */
  _updateIdleState() {
    const queueEmpty = this.queue.length === 0;
    const allWorkersIdle = this._activeTasks === 0;
    const allIdle = allWorkersIdle && queueEmpty;

    if (allIdle && !this._isIdle) {
      // emit idle notification
      this._emitIdle();
    } else if (!allIdle && this._isIdle) {
      // mark non-idle
      this._isIdle = false;
    }
  }

  /**
   * Terminate the entire pool, clear queue and the reaper interval.
   */
  terminate() {
    // Delegate to shutdown to ensure timers cleared and pending Promises rejected
    try {
      this.shutdown();
    } catch (e) {
      // best-effort: swallow to preserve original terminate() semantics
    }
  }

  /**
   * Synchronous disposal hook (TC39 Explicit Resource Management).
   * Allows `using`-style disposal when supported: `pool[Symbol.dispose]()`.
   */
  async [Symbol.dispose]() {
    // Prefer the async disposal path when available so callers can `using`-
    // style dispose against an async cleanup routine. Fall back to
    // synchronous terminate for older runtimes.
    if (typeof this[Symbol.asyncDispose] === 'function') {
      await this[Symbol.asyncDispose]();
      return;
    }
    this.terminate();
  }

  /**
   * Asynchronous disposal hook. Drains outstanding work and then terminates.
   * Use `await pool[Symbol.asyncDispose]()` in environments that support it.
   */
  async [Symbol.asyncDispose]() {
    try {
      await this.drain();
    } catch (err) {
      // ignore drain failures and proceed to terminate
    }
    this.terminate();
  }

  /**
   * Return stats for debugging and telemetry.
   * @returns {{status:{id:number,tasks:number,lastActive:number}[],performance:Object,queueLength:number,activeTasks:number,workerCount:number,minSize:number,maxSize:number,isIdle:boolean}}
   */
  getStats() {
    const status = this.workers.map((w) => ({
      id: w.id,
      tasks: w.tasks,
      lastActive: w.lastActive,
    }));

    const now = nowMs();
    const liveDuration = this._createdAt != null ? Math.max(0, now - this._createdAt) : 0;
    const totalWorkersCreated = this._totalWorkersCreated || this.workers.length;
    const totalTasksPerformed = this._totalTasksCompleted || 0;

    // average number of tasks per worker until termination.
    // Include terminated workers (historical) and currently-alive workers
    // so the metric reflects work-per-worker across the pool lifetime.
    const terminatedCount = this._terminatedWorkerTaskCountsCount || 0;
    const terminatedTotal = this._terminatedWorkerTaskCountsTotal || 0;
    // sum completed tasks for currently alive workers
    let aliveCompletedTotal = 0;
    for (const w of this.workers) aliveCompletedTotal += w.completedTasks || 0;
    const aliveCount = this.workers.length || 0;
    const combinedCount = terminatedCount + aliveCount;
    const avgTasksPerWorkerUntilTermination =
      combinedCount > 0 ? (terminatedTotal + aliveCompletedTotal) / combinedCount : 0;

    // time-per-task statistics (Welford streaming stats provide O(1) memory)
    let min = 0,
      max = 0,
      average = 0,
      stddev = 0,
      percentSlowTasks = 0;
    const count = this._taskDurationsWelfordCount || 0;
    if (count > 0) {
      min = this._taskDurationsMin === Number.POSITIVE_INFINITY ? 0 : this._taskDurationsMin;
      max = this._taskDurationsMax === Number.NEGATIVE_INFINITY ? 0 : this._taskDurationsMax;
      average = this._taskDurationsWelfordMean;
      const variance = count > 1 ? this._taskDurationsWelfordM2 / count : 0;
      stddev = Math.sqrt(variance);
      // percentSlowTasks cannot be computed exactly without retaining samples.
      // For now report 0 when insufficient information is available.
      percentSlowTasks = 0;
    }

    return {
      status,
      performance: {
        poolLiveDuration: liveDuration,
        totalWorkersCreated,
        totalTasksPerformed,
        averageTasksPerWorkerUntilTermination: avgTasksPerWorkerUntilTermination,
        timePerTask: { max, min, average, stddev },
        percentSlowTasks,
      },
      queueLength: this.queue.length,
      activeTasks: this._activeTasks,
      workerCount: this.workers.length,
      minSize: this.minSize,
      maxSize: this.maxSize,
      isIdle: this._activeTasks === 0 && this.queue.length === 0,
    };
  }

  /**
   * Return a Promise that resolves when the pool becomes idle (queue empty and all workers have tasks === 0).
   * Resolves with the result of `getStats()` at the time of idle.
   * @returns {Promise<object>} Promise resolving to `getStats()`.
   */
  drain() {
    const queueEmpty = this.queue.length === 0;
    const allWorkersIdle = this._activeTasks === 0;
    const allIdle = allWorkersIdle && queueEmpty;

    if (allIdle) return Promise.resolve(this.getStats());

    return new Promise((resolve) => {
      const cb = () => {
        try {
          this.removeEventListener('idle', cb);
        } catch (e) {
          this._debugLog?.(e, 'drain: removeEventListener failed');
        }
        resolve(this.getStats());
      };
      this.addEventListener('idle', cb);
    });
  }

  /**
   * Add an event listener for pool events. Supported types: 'message', 'error', 'messageerror', 'idle'.
   * @param {'message'|'error'|'messageerror'|'idle'} type
   * @param {Function} cb
   */
  addEventListener(type, cb) {
    // Supported types: message, error, messageerror, idle, resize
    if (typeof cb !== 'function') return;
    this._bus.on(type, cb);
    // If registering an 'idle' listener while the pool is actually idle,
    // invoke it immediately. Use the same logic as `_updateIdleState`.
    if (type === 'idle') {
      const queueEmpty = this.queue.length === 0;
      const allWorkersIdle = this._activeTasks === 0;
      if (allWorkersIdle && queueEmpty) {
        const ev = { data: { type: 'pool:idle', stats: this.getStats() } };
        try {
          cb(ev);
        } catch (err) {
          this._logger.error(err, 'pool idle listener error');
        }
      }
    }
  }

  /**
   * Remove a previously added event listener.
   * @param {'message'|'error'|'messageerror'|'idle'} type
   * @param {Function} cb
   */
  removeEventListener(type, cb) {
    if (!cb || typeof cb !== 'function') return;
    this._bus.off(type, cb);
  }

  /**
   * onresize handler called when the pool is resized and workers are terminated/added.
   * Receives an event object: `{ data: { type: 'pool:resize', terminated: Array<number>, added: number, minSize, maxSize } }`
   * @type {Function|null}
   */
  get onresize() {
    return this._onresize;
  }
  set onresize(cb) {
    this._onresize = cb;
  }

  /**
   * onmessage handler called when any worker posts a message.
   * @type {Function|null}
   */
  get onmessage() {
    return this._onmessage;
  }
  set onmessage(cb) {
    this._onmessage = cb;
  }

  /**
   * onerror handler called when a worker emits an error.
   * @type {Function|null}
   */
  get onerror() {
    return this._onerror;
  }
  set onerror(cb) {
    this._onerror = cb;
  }

  /**
   * onidle handler called when the pool becomes idle.
   * @type {Function|null}
   */
  get onidle() {
    return this._onidle;
  }
  set onidle(cb) {
    this._onidle = cb;
    if (typeof cb === 'function') {
      const queueEmpty = this.queue.length === 0;
      const allWorkersIdle = this._activeTasks === 0;
      if (allWorkersIdle && queueEmpty) {
        const ev = { data: { type: 'pool:idle', stats: this.getStats() } };
        try {
          cb(ev);
        } catch (err) {
          this._logger.error(err, 'Pool onidle handler error');
        }
      }
    }
  }

  /**
   * Pause dequeueing from the internal task queue.
   * Queued tasks remain in the queue until `resumeQueue()` is called.
   * This is useful for controlled backpressure when downstream consumers
   * are temporarily unable to accept more work.
   */
  pauseQueue() {
    this._queuePaused = true;
  }

  /**
   * Resume dequeueing from the internal task queue and attempt to dispatch
   * waiting tasks to available workers.
   */
  resumeQueue() {
    if (!this._queuePaused) return;
    this._queuePaused = false;
    this._dispatchQueuedTasks();
  }

  /**
   * Alias for `pauseQueue()` to provide a simpler public API.
   */
  pause() {
    return this.pauseQueue();
  }

  /**
   * Alias for `resumeQueue()` to provide a simpler public API.
   */
  resume() {
    return this.resumeQueue();
  }

  /**
   * Whether queued dispatch is currently paused.
   * @returns {boolean}
   */
  get queuePaused() {
    return this._queuePaused;
  }

  /**
   * Dispatch queued tasks to available workers when the queue is not paused.
   * @private
   */
  _dispatchQueuedTasks() {
    if (this._queuePaused || !this.taskQueueEnabled || this.queue.length === 0) return;
    const queue = this.queue;
    const maxTasksPerWorker = this._maxTasksPerWorker;
    const now = nowMs();
    let dispatched = false;

    for (const workerObj of this.workers) {
      let remainingSlots = maxTasksPerWorker - workerObj.tasks;
      while (remainingSlots > 0 && queue.length > 0) {
        const item = queue.shift();
        try {
          if (item.transfer?.length) workerObj.worker.postMessage(item.message, item.transfer);
          else workerObj.worker.postMessage(item.message);
          if (typeof workerObj._startTimes?.push === 'function') workerObj._startTimes.push(now);
          workerObj.tasks++;
          remainingSlots--;
          this._activeTasks++;
          workerObj.lastActive = now;
          dispatched = true;
        } catch (err) {
          this._debugLog?.(err, 'dispatch queued message to worker failed');
          this._logger.error(err, 'Failed to dispatch queued message to worker');
          break;
        }
      }
    }

    if (this._queueHighCrossed && this.queue.length <= this._queueHighThreshold) {
      this._queueHighCrossed = false;
    }
    if (dispatched) this._updateIdleState();
  }
}
