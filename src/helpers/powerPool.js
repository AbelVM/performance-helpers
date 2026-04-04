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

// High-resolution now in milliseconds, mapped to epoch time.
// Use performance.timeOrigin+performance.now() when available, or derive an
// epoch offset for hrtime to keep timestamps comparable with Date.now().
// `nowMs` imported from src/helpers/now.js

/**
 * @typedef {Object} WorkerObj
 * @property {number} id - Numeric id for the worker entry.
 * @property {Worker} worker - The underlying Worker instance or worker-like object.
 * @property {number} tasks - Number of active tasks currently assigned.
 * @property {number} lastActive - Timestamp (ms) of last activity on this worker.
 * @property {number|null} [latencyEwma] - EWMA of historical task latency (ms).
 * @property {number[]} [_startTimes] - Queue of start timestamps for inflight tasks (ms).
 */

/**
 * Manager for a pool of web workers.
 *
 * @example
 * import MinionWorker from './worker.js?worker&inline'
 * const pool = new PowerPool(MinionWorker, { size: 4, idleTimeout: 30000 });
 * pool.onmessage = (e) => { console.log(e.data); };
 * pool.postMessage({ payload: {} });
 */
export class PowerPool {
  /**
   * Create a PowerPool.
   *
   * @param {Function|string} workerSource - A Worker constructor/factory (callable) or a relative path string to pass to `new Worker(new URL(path, import.meta.url))`.
   * @param {Object} [options]
   * @param {number} [options.size] - Initial number of workers to create.
   * @param {number} [options.minSize=1] - Minimum number of workers to keep alive.
   * @param {number} [options.maxSize] - Maximum number of workers allowed in the pool.
   * @param {Object} [options.workerOptions] - Options forwarded to the Worker constructor when using a string path.
   * @param {number} [options.maxTasksPerWorker=Infinity] - Soft capacity per worker before considering it busy.
   * @param {number} [options.idleTimeout=60000] - Milliseconds after which idle workers (beyond `minSize`) will be terminated.
   * @param {boolean} [options.taskQueue=true] - Whether to queue tasks when all workers are busy.
   */
  constructor(workerSource, options = {}) {
    const hwConcurrency = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
    const {
      size = Math.min(hwConcurrency, 2),
      minSize = 1,
      maxSize = Math.max(size, hwConcurrency),
      workerOptions = {},
      maxTasksPerWorker = Infinity,
      idleTimeout = 60_000,
      taskQueue = true,
    } = options;

    this._workerSource = workerSource;
    this._workerOptions = workerOptions;
    this._maxTasksPerWorker = maxTasksPerWorker;
    this.minSize = Math.max(0, minSize);
    this.maxSize = Math.max(this.minSize, maxSize);
    this.idleTimeout = Math.max(0, idleTimeout);
    this.taskQueueEnabled = Boolean(taskQueue);

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
    // running aggregate for terminated workers: total completed tasks and count
    this._terminatedWorkerTaskCountsTotal = 0;
    this._terminatedWorkerTaskCountsCount = 0;

      /** @type {WorkerObj[]} */
      this.workers = [];
      this.queue = new PowerQueue();
    this._listeners = {
      message: new Set(),
      error: new Set(),
      messageerror: new Set(),
      idle: new Set(),
      resize: new Set(),
    };
    this._onmessage = null;
    this._onerror = null;
    this._onidle = null;
    this._onresize = null;
    this._nextIndex = 0;
    // monotonic id allocator for workers to ensure ids remain unique
    this._nextWorkerId = 0;
    /** number of currently active (dispatched) tasks across all workers */
    this._activeTasks = 0;
    /** whether the pool is considered idle (no active tasks and empty queue) */
    this._isIdle = true;

    const initial = Math.min(Math.max(size, this.minSize), this.maxSize);
    for (let i = 0; i < initial; i++) this._addWorkerInstance();

    // reaper checks periodically and terminates idle workers
    this._reaperInterval = setInterval(
      () => this._reapIdleWorkers(),
      Math.max(1000, Math.floor(this.idleTimeout / 2))
    );
    // correlation map for Promise-style postMessage responses
    this._pendingResponses = new Map(); // correlationId -> { resolve, reject, timer }
    this._nextCorrelationId = 1;
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
      this._addWorkerInstance();
      added++;
    }

    // If we have more workers than the new max, terminate excess workers
    const terminatedIds = [];
    while (this.workers.length > this.maxSize) {
      const w = this.workers.pop();
      if (w) {
        // adjust active task counter if worker had inflight tasks
        try {
          this._activeTasks = Math.max(0, this._activeTasks - (w.tasks || 0));
        } catch (e) {
          this._activeTasks = Math.max(0, this._activeTasks - (w.tasks || 0));
        }
        try {
          w.worker.terminate();
        } catch (e) {
          /* ignore */
        }
        try {
          this._terminatedWorkerTaskCountsTotal += w.completedTasks || 0;
          this._terminatedWorkerTaskCountsCount += 1;
        } catch (e) {
          /* ignore */
        }
        try {
          terminatedIds.push(w.id);
        } catch (e) {
          /* ignore */
        }
      }
    }

    // emit resize event/callback when workers were terminated or added
    if (terminatedIds.length || added) {
      const ev = {
        data: {
          type: 'pool:resize',
          terminated: terminatedIds,
          added,
          minSize: this.minSize,
          maxSize: this.maxSize,
        },
      };
      if (this._onresize) {
        try {
          this._onresize(ev);
        } catch (err) {
          console.error('Pool onresize handler error', err);
        }
      }
      for (const cb of this._listeners.resize) {
        try {
          cb(ev);
        } catch (err) {
          console.error('pool resize listener error', err);
        }
      }
    }

    // Re-evaluate idle state after resizing
    this._updateIdleState();
  }

  /**
   * Create a new worker instance using the configured source.
   * @private
   * @returns {Worker|any}
   */
  _createWorkerInstance() {
    if (typeof this._workerSource === 'function') return new this._workerSource();
    if (typeof this._workerSource === 'string') {
      // Resolve a base URL without referencing `import.meta` statically
      // (some build targets like UMD don't support `import.meta`). Use a
      // runtime-evaluated approach and fall back to document/location.
      let baseUrl;
      try {
        // Attempt to read `import.meta.url` at runtime using a dynamic
        // function so bundlers won't statically parse `import.meta`.
        // If unavailable this will throw or return undefined.
        // eslint-disable-next-line no-new-func
        baseUrl = new Function(
          'try { return import.meta && import.meta.url } catch (e) { return undefined }'
        )();
      } catch (e) {
        baseUrl = undefined;
      }

      if (!baseUrl && typeof document !== 'undefined') {
        const cs = document.currentScript;
        if (cs && cs.src) baseUrl = cs.src;
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

  /**
   * Add and wire a new worker instance into the pool.
   * @private
   * @param {number} id
   * @returns {WorkerObj}
   */
  _addWorkerInstance(id) {
    if (id == null) id = this._nextWorkerId++;
    const underlying = this._createWorkerInstance();

    // wrapper around the underlying worker that transparently encodes
    // outgoing object messages to a transferable Uint8Array and decodes
    // incoming Uint8Array/ArrayBuffer messages back to objects.
    const worker = {
      _underlying: underlying,
      postMessage: (message, transfer) => {
        let msg = message;
        let tr = transfer;
        const isPlainObject =
          message !== null &&
          typeof message === 'object' &&
          !ArrayBuffer.isView(message) &&
          !(message instanceof ArrayBuffer);
        if (isPlainObject) {
          try {
            const u8 = o2u8(message);
            // normalize transfer list to array and ensure buffer is included
            const tarr = tr ? Array.from(tr) : [];
            if (!tarr.includes(u8.buffer)) tarr.push(u8.buffer);
            tr = tarr;
            msg = u8;
          } catch (err) {
            // fall back to original message if encoding fails
            tr = transfer;
            msg = message;
          }
        }

        try {
          if (tr && tr.length) underlying.postMessage(msg, tr);
          else underlying.postMessage(msg);
        } catch (err) {
          // surface the error to caller environment (console for now)
          console.error('Failed to postMessage to underlying worker', err);
          throw err;
        }
      },
      addEventListener: (...args) => underlying.addEventListener(...args),
      removeEventListener: (...args) => underlying.removeEventListener(...args),
      terminate: () => {
        if (typeof underlying.terminate === 'function') underlying.terminate();
      },
      // these will be assigned by the pool and invoked when underlying
      // forwards decoded messages
      onmessage: null,
      onerror: null,
      onmessageerror: null,
    };

    const workerObj = {
      id,
      worker,
      tasks: 0,
      lastActive: nowMs(),
      latencyEwma: null,
      _startTimes: [],
    };
    // track completed tasks per worker (for termination-time averages)
    workerObj.completedTasks = 0;
    this.workers.push(workerObj);
    this._totalWorkersCreated++;

    // pool-level handler: decrements tasks, dispatches queued work and
    // forwards messages to pool listeners. This is assigned on the
    // wrapper `worker` so the underlying worker can forward a decoded
    // event into it.
    worker.onmessage = (e) => {
      const now = nowMs();
      workerObj.tasks = Math.max(0, workerObj.tasks - 1);
      // decrement global active task count for the completed task
      try {
        this._activeTasks = Math.max(0, this._activeTasks - 1);
      } catch (err) {
        this._activeTasks = 0;
      }
      workerObj.lastActive = now;

      // If the worker's response carries a correlationId, resolve any pending Promise.
      try {
        const data = e && e.data;
        if (data && typeof data === 'object' && data.correlationId != null) {
          const pid = data.correlationId;
          const pending = this._pendingResponses.get(pid);
          if (pending) {
            try {
              const resp = Object.prototype.hasOwnProperty.call(data, 'response')
                ? data.response
                : data;
              pending.resolve(resp);
            } catch (err) {
              try {
                pending.reject(err);
              } catch (e2) {
                /* ignore */
              }
            } finally {
              if (pending.timer) clearTimeout(pending.timer);
              this._pendingResponses.delete(pid);
            }
          }
        }
      } catch (err) {
        /* non-fatal */
      }

      // Update EWMA latency using the oldest start timestamp for this worker if present
      try {
        const start =
          workerObj._startTimes && workerObj._startTimes.length
            ? workerObj._startTimes.shift()
            : null;
        // Prefer worker-reported processing duration when available (worker may measure its own CPU time),
        // otherwise fall back to wall-clock latency computed from the recorded start time.
        let x = null;
        try {
          const data = e && e.data;
          if (data && typeof data.duration === 'number' && Number.isFinite(data.duration)) {
            x = Math.max(0, Number(data.duration));
          } else if (start != null) {
            x = Math.max(0, now - start);
          }

          if (x != null) {
            const alpha = 0.2; // smoothing factor for EWMA
            if (workerObj.latencyEwma == null) workerObj.latencyEwma = x;
            else workerObj.latencyEwma = alpha * x + (1 - alpha) * workerObj.latencyEwma;

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
          // non-fatal: ignore latency tracking failures
        }
      } catch (err) {
        // non-fatal: ignore latency tracking failures
      }

      // dispatch queued task if any
      if (this.queue.length > 0 && workerObj.tasks < this._maxTasksPerWorker) {
        const item = this.queue.shift();
        try {
          const startTime = nowMs();
          if (item.transfer) worker.postMessage(item.message, item.transfer);
          else worker.postMessage(item.message);
          workerObj._startTimes.push(startTime);
          workerObj.tasks++;
          this._activeTasks++;
        } catch (err) {
          console.error('Failed to dispatch queued message to worker', err);
        }
      }

      if (this._onmessage) {
        try {
          this._onmessage(e);
        } catch (err) {
          console.error('Pool onmessage handler error', err);
        }
      }
      for (const cb of this._listeners.message) {
        try {
          cb(e);
        } catch (err) {
          console.error('pool listener error', err);
        }
      }

      // update idle state after processing a message (and possibly dispatching queued tasks)
      this._updateIdleState();
    };

    // forward underlying events, decoding binary payloads to JS objects
    const _handleMessage = (e) => {
      // support both browser-like MessageEvent (with .data) and Node 'message' callbacks (data passed directly)
      let data = e && e.data !== undefined ? e.data : e;
      let decoded = data;
      if (data && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
        try {
          decoded = u82o(data);
        } catch (err) {
          decoded = data;
        }
      }
      const ev = { data: decoded, originalEvent: e };
      if (typeof worker.onmessage === 'function') {
        try {
          worker.onmessage(ev);
        } catch (err) {
          console.error('worker wrapper onmessage error', err);
        }
      }
    };

    const _handleError = (e) => {
      if (typeof worker.onerror === 'function') {
        try {
          worker.onerror(e);
        } catch (err) {
          console.error('worker wrapper onerror error', err);
        }
      }
      for (const cb of this._listeners.error) {
        try {
          cb(e);
        } catch (err) {
          console.error('pool error listener error', err);
        }
      }
    };

    const _handleMessageError = (e) => {
      if (typeof worker.onmessageerror === 'function') {
        try {
          worker.onmessageerror(e);
        } catch (err) {
          console.error('worker wrapper onmessageerror error', err);
        }
      }
      for (const cb of this._listeners.messageerror) {
        try {
          cb(e);
        } catch (err) {
          console.error('pool messageerror listener error', err);
        }
      }
    };

    // Attach handlers in a cross-platform way (Worker in browsers and Node.js worker_threads)
    if (typeof underlying.addEventListener === 'function') {
      try { underlying.addEventListener('message', _handleMessage); } catch (e) { /* ignore */ }
      try { underlying.addEventListener('error', _handleError); } catch (e) { /* ignore */ }
      try { underlying.addEventListener('messageerror', _handleMessageError); } catch (e) { /* ignore */ }
    } else if (typeof underlying.on === 'function') {
      try { underlying.on('message', _handleMessage); } catch (e) { /* ignore */ }
      try { underlying.on('error', _handleError); } catch (e) { /* ignore */ }
      try { underlying.on('messageerror', _handleMessageError); } catch (e) { /* ignore */ }
    } else {
      // last-resort assignments
      try { underlying.onmessage = _handleMessage; } catch (e) { /* ignore */ }
      try { underlying.onerror = _handleError; } catch (e) { /* ignore */ }
      try { underlying.onmessageerror = _handleMessageError; } catch (e) { /* ignore */ }
    }

    return workerObj;
  }

  /**
   * Return the least-loaded worker (smallest `tasks` count).
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
   * Post a message to a worker in the pool.
   * The pool will try to reuse an idle/least-loaded worker, grow the pool
   * (up to `maxSize`), or queue the task if configured.
   *
   * @param {*} message - The message to post to a worker.
   * @param {Transferable[]=} transfer - Optional transfer list.
   * @returns {boolean} True if the message was accepted (dispatched or queued).
   */
  postMessage(message, transfer, options) {
    // support optional third-argument `options` for Promise-based responses
    options = options || undefined;
    // support explicit per-worker targeting via `options.workerId`
    const targetWorkerId = options && options.workerId != null ? options.workerId : null;
    // prefer an existing idle/least-loaded worker
    const least = targetWorkerId != null ? this.workers.find((w) => w.id === targetWorkerId) : this._findLeastLoadedWorker();

    // support awaiting a response: options.awaitResponse or explicit options.correlationId
    const wantResponse = Boolean(
      options && (options.awaitResponse || options.correlationId != null)
    );
    let correlationId;
    let pendingPromise;
    if (wantResponse) {
      // Bound the correlation id to 32 bits to avoid unbounded integer growth
      // in extremely long-lived pools. Use unsigned 32-bit wrap-around.
      correlationId = options.correlationId != null ? options.correlationId : String((this._nextCorrelationId++ ) >>> 0);
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

      pendingPromise = new Promise((resolve, reject) => {
        const entry = { resolve, reject, timer: null };
        if (options && options.timeout) {
          entry.timer = setTimeout(() => {
            if (this._pendingResponses.has(correlationId)) {
              this._pendingResponses.delete(correlationId);
              reject(new Error('postMessage response timeout'));
            }
          }, options.timeout);
        }
        this._pendingResponses.set(correlationId, entry);
      });
    }

    if (least && least.tasks < this._maxTasksPerWorker) {
      try {
        const startTime = nowMs();
        if (transfer) least.worker.postMessage(message, transfer);
        else least.worker.postMessage(message);
        // record start time for latency tracking and increment task count
        if (Array.isArray(least._startTimes)) least._startTimes.push(startTime);
        least.tasks++;
        this._activeTasks++;
        least.lastActive = startTime;
        // mark pool as non-idle and update state
        this._updateIdleState();
        return wantResponse ? pendingPromise : true;
      } catch (err) {
        // cleanup pending on failure and return the rejected Promise when caller awaited a response
        if (wantResponse && correlationId) {
          const p = this._pendingResponses.get(correlationId);
          if (p) {
            if (p.timer) clearTimeout(p.timer);
            this._pendingResponses.delete(correlationId);
            try {
              p.reject(err);
            } catch (e) {
              /* ignore */
            }
          }
          console.error('Failed to postMessage to worker', err);
          return pendingPromise;
        }
        console.error('Failed to postMessage to worker', err);
        return false;
      }
    }

    // If a specific workerId was requested but we didn't dispatch above,
    // fail fast: the targeted worker is missing or at capacity.
    if (targetWorkerId != null && (!least || least.tasks >= this._maxTasksPerWorker)) {
      if (wantResponse && correlationId) {
        const p = this._pendingResponses.get(correlationId);
        if (p) {
          if (p.timer) clearTimeout(p.timer);
          this._pendingResponses.delete(correlationId);
          try {
            p.reject(new Error('targeted worker unavailable'));
          } catch (e) {
            /* ignore */
          }
        }
        return pendingPromise;
      }
      return false;
    }

    // if we can grow the pool, create a new worker and use it
    // If a specific workerId was requested, do not auto-grow the pool to satisfy it
    if (targetWorkerId == null && this.workers.length < this.maxSize) {
      const obj = this._addWorkerInstance();
      try {
        const startTime = nowMs();
        if (transfer) obj.worker.postMessage(message, transfer);
        else obj.worker.postMessage(message);
        if (Array.isArray(obj._startTimes)) obj._startTimes.push(startTime);
        obj.tasks++;
        this._activeTasks++;
        obj.lastActive = startTime;
        // new worker means pool not idle
        this._updateIdleState();
        return wantResponse ? pendingPromise : true;
      } catch (err) {
        // cleanup pending on failure and return rejected Promise if caller awaited a response
        if (wantResponse && correlationId) {
          const p = this._pendingResponses.get(correlationId);
          if (p) {
            if (p.timer) clearTimeout(p.timer);
            this._pendingResponses.delete(correlationId);
            try {
              p.reject(err);
            } catch (e) {
              /* ignore */
            }
          }
          console.error('Failed to postMessage to new worker', err);
          return pendingPromise;
        }
        console.error('Failed to postMessage to new worker', err);
        return false;
      }
    }

    // pool full and all workers at capacity (or targeted worker busy/missing)
    if (this.taskQueueEnabled) {
      this.queue.push({ message, transfer });
      // queued task means pool not idle (but not an active dispatched task)
      this._updateIdleState();
      return wantResponse ? pendingPromise : true;
    }

    // fallback: round-robin dispatch. Use modulo to keep `_nextIndex` bounded
    if (!this.workers.length) return wantResponse ? pendingPromise : false;
    const idx = this._nextIndex % this.workers.length;
    // advance and wrap to avoid unbounded integer growth
    this._nextIndex = (this._nextIndex + 1) % this.workers.length;
    const fallback = this.workers[idx];
      try {
        const startTime = nowMs();
      if (transfer) fallback.worker.postMessage(message, transfer);
      else fallback.worker.postMessage(message);
      if (Array.isArray(fallback._startTimes)) fallback._startTimes.push(startTime);
      fallback.tasks++;
      this._activeTasks++;
      fallback.lastActive = startTime;
      this._updateIdleState();
      return wantResponse ? pendingPromise : true;
    } catch (err) {
      // cleanup pending on failure and return rejected Promise if caller awaited a response
      if (wantResponse && correlationId) {
        const p = this._pendingResponses.get(correlationId);
        if (p) {
          if (p.timer) clearTimeout(p.timer);
          this._pendingResponses.delete(correlationId);
          try {
            p.reject(err);
          } catch (e) {
            /* ignore */
          }
        }
        console.error('Failed to postMessage to fallback worker', err);
        return pendingPromise;
      }
      console.error('Failed to postMessage to fallback worker', err);
      return false;
    }
  }

  /**
   * Broadcasts a message to all workers in the pool.
   * @param {*} message
   * @param {Transferable[]=} transfer
   * @returns {void}
   */
  broadcast(message, transfer) {
    // Snapshot the time once for this broadcast to avoid multiple syscalls
    // and to keep `lastActive` consistent across all workers in this broadcast.
    const now = nowMs();
    for (const w of this.workers) {
      try {
        if (transfer) w.worker.postMessage(message, transfer);
        else w.worker.postMessage(message);
        // record start time for latency tracking (use same timestamp for all records in this iteration)
        if (Array.isArray(w._startTimes)) w._startTimes.push(now);
        w.tasks++;
        this._activeTasks++;
        w.lastActive = now;
      } catch (err) {
        console.error('broadcast error', err);
      }
    }
    this._updateIdleState();
  }

  /**
   * Add one worker to the pool immediately.
   * @returns {WorkerObj} The newly created worker entry.
   */
  addWorker() {
    return this._addWorkerInstance();
  }

  /**
   * Remove the last worker from the pool and terminate it.
   * @returns {void}
   */
  removeWorker() {
    const w = this.workers.pop();
    if (w) {
      // adjust global active task counter if worker had inflight tasks
      try {
        this._activeTasks = Math.max(0, this._activeTasks - (w.tasks || 0));
      } catch (err) {
        this._activeTasks = Math.max(0, this._activeTasks - (w.tasks || 0));
      }
      try {
        w.worker.terminate();
      } catch (err) {
        /* ignore */
      }
      try {
        this._terminatedWorkerTaskCountsTotal += w.completedTasks || 0;
        this._terminatedWorkerTaskCountsCount += 1;
      } catch (err) {
        /* ignore */
      }
    }
  }

  /**
   * Internal: terminate workers that have been idle longer than `idleTimeout`.
   * Keeps at least `minSize` workers alive.
   * @private
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
          /* ignore */
        }
        try {
          this._terminatedWorkerTaskCountsTotal += w.completedTasks || 0;
          this._terminatedWorkerTaskCountsCount += 1;
        } catch (err) {
          /* ignore */
        }
        this.workers.splice(i, 1);
      }
    }
    // re-evaluate idle state after pruning
    this._updateIdleState();
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
   * Example:
   * ```javascript
   * pool.addEventListener('idle', (e) => {
   *   // e.data.type === 'pool:idle'
   *   console.log('Pool idle, stats=', e.data.stats);
   * });
   * ```
   *
   * @private
   */
  _emitIdle() {
    const ev = { data: { type: 'pool:idle', stats: this.getStats() } };
    this._isIdle = true;
    if (this._onmessage) {
      try {
        this._onmessage(ev);
      } catch (err) {
        console.error('Pool onmessage handler error', err);
      }
    }
    if (this._onidle) {
      try {
        this._onidle(ev);
      } catch (err) {
        console.error('Pool onidle handler error', err);
      }
    }
    for (const cb of this._listeners.message) {
      try {
        cb(ev);
      } catch (err) {
        console.error('pool listener error', err);
      }
    }
    for (const cb of this._listeners.idle) {
      try {
        cb(ev);
      } catch (err) {
        console.error('pool idle listener error', err);
      }
    }
  }

  /**
   * Check current state and emit idle event if transitioning to idle.
   * @private
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
    if (this._reaperInterval) {
      clearInterval(this._reaperInterval);
      this._reaperInterval = null;
    }
    for (const w of this.workers) {
      try {
        w.worker.terminate();
      } catch (err) {
        /* ignore */
      }
      try {
        this._terminatedWorkerTaskCountsTotal += w.completedTasks || 0;
        this._terminatedWorkerTaskCountsCount += 1;
      } catch (err) {
        /* ignore */
      }
    }
    this.workers = [];
    this.queue = new PowerQueue();
    this._activeTasks = 0;
  }

  /**
   * Synchronous disposal hook (TC39 Explicit Resource Management).
   * Allows `using`-style disposal when supported: `pool[Symbol.dispose]()`.
   */
  [Symbol.dispose]() {
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
   * Return stats for debugging.
   * @returns {{status:{id:number,tasks:number,lastActive:number}[],performance:Object}}
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
    const avgTasksPerWorkerUntilTermination = combinedCount > 0 ? (terminatedTotal + aliveCompletedTotal) / combinedCount : 0;

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
          /* ignore */
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
    if (!(type in this._listeners)) return;
    this._listeners[type].add(cb);
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
          console.error('pool idle listener error', err);
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
    if (type in this._listeners) this._listeners[type].delete(cb);
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
          console.error('Pool onidle handler error', err);
        }
      }
    }
  }
}
