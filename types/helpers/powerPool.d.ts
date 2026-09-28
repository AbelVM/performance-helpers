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
    constructor(message?: string);
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
 *
 * @example <caption>Explicit Resource Management (Node >= 22.12 / modern browsers)</caption>
 * // `Symbol.dispose` runs synchronously, so `using` hard-stops the pool at
 * // scope exit. Prefer `await using` to drain in-flight work first.
 * import MinionWorker from './worker.js?worker&inline'
 * {
 *   using pool = new PowerPool(MinionWorker, { size: 4 });
 *   await pool.postMessage({ payload: {} }, undefined, { awaitResponse: true });
 * } // pool.shutdown() is called here, synchronously
 *
 * // To drain pending tasks before terminating:
 * {
 *   await using pool = new PowerPool(MinionWorker, { size: 4 });
 *   await pool.postMessage({ payload: {} }, undefined, { awaitResponse: true });
 * } // pool[Symbol.asyncDispose]() drains then terminates
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
     * @param {number} [options.slowTaskThreshold=Infinity] - Task duration (ms) above which a completed task is counted as "slow". When finite, `stats().performance.percentSlowTasks` reports the exact percentage of tasks exceeding this threshold. Defaults to `Infinity` (disabled; `percentSlowTasks` stays `0`).
     */
    constructor(workerSource: Function | string, options?: PowerPoolOptions | undefined, ...args: any[]);
    _workerSource: string | Function;
    _workerOptions: Object;
    _maxTasksPerWorker: number;
    minSize: number;
    maxSize: number;
    idleTimeout: number;
    taskQueueEnabled: boolean;
    _queuePolicy: "enqueue" | "drop-oldest" | "drop-newest" | "reject";
    _createdAt: number;
    _totalWorkersCreated: number;
    _totalTasksCompleted: number;
    _taskDurationsWelfordCount: number;
    _taskDurationsWelfordMean: number;
    _taskDurationsWelfordM2: number;
    _taskDurationsMin: number;
    _taskDurationsMax: number;
    _slowTaskThreshold: number;
    _slowTaskCount: number;
    _ewmaLatency: any;
    _autoScale: {
        enabled: boolean;
        intervalMs: number;
        targetMs: number;
        alpha: number;
        cooldownMs: number;
        hysteresis: number;
        stepUp: number;
        stepDown: number;
        backoffFactor: number;
        backoffMaxMultiplier: number;
        backoffResetMs: number;
        policy: "ewma" | "aimd" | "vegas" | "gradient2" | undefined;
        limitMin: number;
        limitMax: number;
        longWindowAlpha: number;
        aimdBeta: number;
    } | null;
    _autoScaleInterval: any;
    _lastAutoScaleAt: number;
    _terminatedWorkerTaskCountsTotal: number;
    _terminatedWorkerTaskCountsCount: number;
    /** @type {WorkerObj[]} */
    workers: WorkerObj[];
    queue: PowerQueue;
    _bus: PowerEventBus;
    _queueHighThreshold: number;
    _queueHighCrossed: boolean;
    _onmessage: Function | null;
    _onerror: Function | null;
    _onidle: Function | null;
    _onresize: Function | null;
    _nextIndex: number;
    _nextWorkerId: number;
    /** number of currently active (dispatched) tasks across all workers */
    _activeTasks: number;
    /** whether the pool is considered idle (no active tasks and empty queue) */
    _isIdle: boolean;
    /** whether queued dispatch is paused */
    _queuePaused: boolean;
    /**
     * Wire protocol for object messages.
     *
     * - `'framed'` (**default since 2.0**) posts a `PowerMessageCodec`
     *   envelope: `[version][codec][length][payload]`. Workers read
     *   `decodeMessage(e.data).value` instead of `u82o(e.data)`, binary frames
     *   survive intact, and the version byte lets the protocol evolve without
     *   another flag day.
     * - `'legacy'` restores the 1.x behaviour: a bare `Uint8Array` of JSON,
     *   sniffed on the way back in. Provided so a worker can be migrated on its
     *   own schedule. See the migration note in guides/powerPool.md.
     *
     * @type {'framed'|'legacy'}
     */
    _messageCodec: "framed" | "legacy";
    /**
     * Terminal flag. Set by `shutdown()` / `terminate()`; once true the pool
     * refuses to dispatch, enqueue or grow, so a late `postMessage()` cannot
     * resurrect it (which previously created a worker with no reaper
     * interval, pinning the Node.js process).
     * @type {boolean}
     */
    _terminated: boolean;
    /**
     * Monotonic token per dispatched task, used to make `_activeTasks`
     * accounting idempotent: a late `message` from a worker terminated by
     * `resize()`/`removeWorker()` no longer double-decrements the counter.
     * @type {number}
     */
    _taskTokenSeq: number;
    _logger: PowerLogger;
    _pendingResponses: Map<any, any>;
    _underlyingToWorkerObj: Map<any, any>;
    _defaultAwaitResponseTimeout: number;
    _reaperInterval: any;
    _encodeCache: Map<any, any>;
    _encodeCacheLimit: number;
    _encodeCacheByteLimit: number;
    _encodeCacheBytes: number;
    _autoScaleBackoffMultiplier: number | undefined;
    _adaptiveLimit: number | undefined;
    _longEwmaLatency: any;
    _minLatencyWindow: number | undefined;
    _lastAdaptiveLimit: number | undefined;
    _congestion: boolean | undefined;
    /**
     * Log debug information about swallowed errors when debug logging is enabled.
     * @param {*} err - The swallowed error, or falsy when the call is informational.
     * @param {string} [msg]
     * @returns {void}
     * @private
     */
    private _debugLog;
    /** Ensure the reaper interval exists; recreate it if missing. @private */
    private _ensureReaper;
    _createPendingResponsePromise(correlationId: any, options: any): {
        pendingPromise: Promise<any>;
        correlationKey: any;
    };
    /**
     * Post a prepared message to a specific worker object and update bookkeeping.
     * Returns the `pendingPromise` when `wantResponse` is true, otherwise `true` on success.
     * On failure, rejects/cleans up the pending response when applicable and
     * returns `pendingPromise` (when awaiting) or `false`.
     * @param {import('./jsdoc-types.js').WorkerObj} obj
     * @param {{message: *, transfer: (TransferList|undefined)}} prepared
     * @param {number} startTime
     * @param {boolean} wantResponse
     * @param {string|undefined} correlationKey
     * @param {Promise<any>} pendingPromise
     * @returns {Promise<any>|boolean}
     * @private
     */
    private _postToWorkerObj;
    /**
     * Attempt to grow the pool by adding a worker and dispatching the message.
     * Preserves the same pending-response cleanup semantics as inline logic.
     * @param {*} message
     * @param {TransferList} [transfer]
     * @param {Object} [options]
     * @param {number} startTime
     * @param {boolean} [wantResponse]
     * @param {string} [correlationId]
     * @param {number} [timeout]
     * @returns {Promise<any>|boolean}
     * @private
     */
    private _tryGrowPool;
    /**
     * Enqueue or reject a prepared message according to the configured queue policy.
     * Returns `pendingPromise`/`true`/`false` to match `postMessage` semantics.
     * @private
     */
    private _enqueueOrReject;
    /**
     * Single choke point for retiring a worker from the pool.
     *
     * Every removal path - `shutdown()`, `removeWorker()`, `resize()`,
     * `_autoScaleTick()`, `_reapIdleWorkers()` and `_resetPoolForStopThePress()`
     * - routes through here so the active-task accounting, the terminated-worker
     * statistics and the underlying-worker mapping can no longer drift apart
     * between paths (the idle reaper previously skipped the statistics
     * entirely, inflating `getStats().performance.timePerTask` over time).
     *
     * Note: this deliberately does **not** remove the entry from `this.workers`;
     * callers own the array bookkeeping (some paths pop, some swap-remove, the
     * shutdown path clears the whole list).
     *
     * @param {WorkerObj|null} workerObj - Worker entry to retire.
     * @param {string} [reason] - Why the worker is being removed, used for
     *   debug logging only.
     * @returns {number|null} The retired worker id, or `null` when nothing was
     *   retired.
     * @private
     */
    private _terminateWorker;
    /**
     * Throws when the pool has been shut down. Called from every public entry
     * point that would otherwise dispatch, enqueue or grow workers.
     * @private
     */
    private _assertNotTerminated;
    /**
     * Clear lifecycle timer intervals used by the pool.
     * @private
     */
    private _clearLifecycleIntervals;
    /**
     * Shutdown the pool: clear timers, reject pending responses, terminate workers,
     * and clear internal queues. This is a full stop that prevents background
     * timers from keeping the process alive.
     *
     * Shutdown is **final**: the pool refuses every subsequent `postMessage()`,
     * `postMessageBatch()`, `addWorker()` and `resize()` with an
     * `ERR_POOL_TERMINATED` error rather than silently recreating workers.
     * Create a new `PowerPool` to start again.
     *
     * @returns {void}
     */
    shutdown(): void;
    /**
     * Encode a plain object to a Uint8Array, using a small cache to avoid
     * repeated encoding work for identical messages. Returns a Uint8Array.
     * @private
     * @param {Object} obj
     * @returns {Uint8Array}
     */
    /**
     * Wrap an encoded JSON body in a `PowerMessageCodec` envelope.
     *
     * The frame is built over a single `Uint8Array` so the existing transfer and
     * slicing logic above is unchanged; the header is six bytes, so this is a
     * `set` rather than a second allocation plus a copy.
     *
     * @private
     * @param {Uint8Array} body - Encoded JSON payload.
     * @returns {Uint8Array} The framed message.
     */
    private _encodeForTransfer;
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
    prepareBuffers(items: Array<any | {
        message: any;
        transfer?: Transferable[];
    }>, options?: {
        clone?: boolean;
    } | undefined): {
        message: any;
        transfer: Transferable[] | undefined;
    }[];
    /**
     * Class-level helper to prepare a message and optional transfer list for posting to a worker.
     * Accepts `opts` with `zeroCopy` flag to control forwarding of raw buffers.
     * @private
     */
    private _prepareForTransfer;
    /**
     * Decrement the global active task counter safely.
     * Ensures the counter never goes negative and centralizes error handling.
     * @private
     * @param {number} [n=1]
     */
    private _decrementActiveTasks;
    /**
     * Resize the pool's maximum size at runtime.
     * If `n` is smaller than the current number of workers, extra workers
     * will be terminated (keeps at least `minSize`). If `n` is larger,
     * the pool may grow up to the new limit when demand increases.
     * @param {number} n - New maximum pool size.
     */
    resize(n: number): void;
    /**
     * Create a new worker instance using the configured source.
     *
     * Worker creation is delegated to `WorkerAgnostic`, which transparently
     * resolves the configured `workerSource` (a Worker constructor, a factory
     * function, or a path/URL string) into the appropriate native worker for the
     * current runtime — Node.js `worker_threads` or a Web Worker — without any
     * environment-specific branching in this pool. Throws when `workerSource`
     * is neither a function nor a string.
     *
     * @private
     * @returns {Worker|any} The underlying worker instance or factory result.
     * @throws {Error} When `workerSource` is invalid or worker construction fails.
     */
    private _createWorkerInstance;
    _deleteWorkerUnderlyingMapping(workerObj: any): void;
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
    private _addWorkerInstance;
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
    private _findLeastLoadedWorker;
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
    postMessage(message: any, transfer?: Transferable[] | undefined, options?: PostMessageOptions | undefined): boolean | Promise<any>;
    /**
     * Generate a correlation id for a pending response.
     *
     * Shape is `<processTag>-<sequence>`, both base 36. The sequence is
     * monotonic for the whole **process**, not for the pool, so ids are unique
     * across every pool in it - which subsumes uniqueness within one pool, the
     * only matching that actually happens (a response arriving at the pool that
     * sent it, looked up in that pool's pending map). The process tag exists so
     * two processes sharing a log do not produce identical ids, and costs one
     * `Math.random` for the whole process rather than one per message.
     *
     * A per-pool counter with a shared tag is *not* sufficient: two pools both
     * emit `<tag>-0`. That was the first version of this change and its own test
     * caught it.
     *
     * This replaced `crypto.randomUUID()` (PERF-002), which was ~7.7x slower
     * per id and produced ids more than four times longer. `randomUUID` buys
     * cross-process uniqueness, which correlation matching does not need; the
     * process tag buys it for free at the cost of one allocation. Measured over
     * 200k ids: 0.163 us -> 0.021 us, 42 chars -> 10.
     *
     * @private
     * @returns {string}
     */
    private _generateCorrelationId;
    /**
     * Centralized cleanup for a pending response entry.
     * Ensures the timer is cleared and the entry is resolved/rejected exactly once.
     * @private
     * @param {string|number} key
     * @param {{resolveWith?:any, rejectWith?:any}} opts
     */
    private _cleanupPendingResponse;
    /**
     * Broadcasts a message to all workers in the pool.
     * @param {*} message
     * @param {Transferable[]=} transfer - Optional transfer list. If omitted and a
     * plain JS object is supplied, the pool will attempt to encode the object for
     * each worker into a transferable `Uint8Array` (via `o2u8`) so each worker
     * receives an independent transferable buffer to avoid structured-clone copies.
     * @returns {void}
     */
    broadcast(message: any, transfer?: Transferable[] | undefined): void;
    /**
     * Normalize stop-the-press options and strip internal-only flags.
     * @private
     * @param {Object=} options
     * @returns {{recreate: boolean, fwdOptions: Object|undefined}}
     */
    private _normalizeStopThePressOptions;
    /**
     * Shared reset routine used by stop-the-press APIs.
     * Clears queue and pending responses, terminates workers, optionally recreates workers,
     * and updates idle state.
     * @private
     * @param {{recreate:boolean, scope:string}} config
     * @returns {{currentCount:number, terminatedIds:number[]}}
     */
    private _resetPoolForStopThePress;
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
    stopThePress(message: any, transfer?: Transferable[] | undefined, options?: Object | undefined): boolean | Promise<any>;
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
    postMessageBatch(items: {
        message: any;
        transfer?: Transferable[];
    }[], options?: Object | undefined): (boolean | Promise<any>)[];
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
    stopThePressBatch(items: {
        message: any;
        transfer?: Transferable[];
    }[], options?: Object | undefined): (boolean | Promise<any>)[];
    /**
     * Add one worker to the pool immediately.
     * @returns {WorkerObj} The newly created worker entry.
     */
    addWorker(): WorkerObj;
    /**
     * Remove the last worker from the pool and terminate it.
     * @returns {void}
     */
    removeWorker(): void;
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
    private _reapIdleWorkers;
    /**
     * Update the adaptive concurrency limit for this tick.
     *
     * The limit is a float in `[limitMin, limitMax]`, smoothed with
     * `smoothedLimit` below. These are the concurrency-control algorithms from
     * Netflix's `concurrency-limits`, which ports TCP congestion control to a
     * request concurrency window. The pool already tracks exactly the signals
     * they need, so this replaces guesswork with a feedback loop.
     *
     * - `aimd` — additive increase while healthy, multiplicative decrease on a
     *   congestion signal. Simplest and most robust.
     * - `vegas` — estimates the bottleneck queue as
     *   `limit * (1 - minRtt / currentRtt)`, increasing by `alpha` when that is
     *   below a threshold and decreasing by `beta` when above it. The reference
     *   implementation uses `alpha = 3*log10(limit)` and `beta = 6*log10(limit)`.
     * - `gradient2` — the divergence between a long- and a short-window RTT EWMA,
     *   `gradient = clamp(longRtt / currentRtt, 0.5, 1)`, then
     *   `limit = gradient * limit + queueSize`, smoothed. Unlike Vegas it does
     *   not use the window *minimum* latency, which biases the estimate.
     *
     * `ewma` (the default) does nothing here: it keeps the original
     * target-latency-threshold behaviour in `_autoScaleTick` unchanged.
     *
     * @returns {number} The updated limit.
     * @private
     */
    private _updateAdaptiveLimit;
    /**
     * Autoscale tick: simple policy that grows/shrinks by one worker based on
     * pool-level EWMA latency and queue pressure. Runs only when `autoScale`
     * is configured on the pool.
     *
     * - scale up: when EWMA > targetMs OR queue length exceeds worker count
     * - scale down: when EWMA < targetMs * 0.5 AND queue is empty
     * @private
     */
    private _autoScaleTick;
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
    /**
     * Build the idle event object. `stats` is computed lazily (via a getter) so
     * the `getStats()` allocation (which maps over all workers) is skipped on
     * idle transitions when no listener actually reads `ev.data.stats`.
     * @private
     * @returns {{data:{type:string,stats:object}}}
     */
    private _buildIdleEvent;
    _emitIdle(): void;
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
    private _updateIdleState;
    /**
     * Terminate the entire pool, clear queue and the reaper interval.
     */
    terminate(): void;
    /**
     * Synchronous disposal hook (TC39 Explicit Resource Management).
     * Allows `using`-style disposal when supported: `pool[Symbol.dispose]()`.
     * Must be synchronous (returns `undefined`) so `using` blocks don't await
     * and leak in-flight work; it performs a hard stop via `shutdown()`.
     */
    /**
     * Named alias for the `Symbol.dispose` implementation, so callers who do not
     * want to reach for the symbol still have something to call.
     * @returns {void}
     */
    dispose(): void;
    /**
     * Return stats for debugging and telemetry.
     * @returns {{status:{id:number,tasks:number,lastActive:number}[],performance:Object,queueLength:number,activeTasks:number,workerCount:number,minSize:number,maxSize:number,isIdle:boolean}}
     */
    getStats(): {
        status: {
            id: number;
            tasks: number;
            lastActive: number;
        }[];
        performance: Object;
        queueLength: number;
        activeTasks: number;
        workerCount: number;
        minSize: number;
        maxSize: number;
        isIdle: boolean;
    };
    /**
     * Return a Promise that resolves when the pool becomes idle (queue empty and all workers have tasks === 0).
     * Resolves with the result of `getStats()` at the time of idle.
     * @returns {Promise<object>} Promise resolving to `getStats()`.
     */
    drain(options?: {}): Promise<object>;
    /**
     * Add an event listener for pool events. Supported types: 'message', 'error', 'messageerror', 'idle'.
     * @param {'message'|'error'|'messageerror'|'idle'} type
     * @param {Function} cb
     */
    addEventListener(type: "message" | "error" | "messageerror" | "idle", cb: Function): void;
    /**
     * Remove a previously added event listener.
     * @param {'message'|'error'|'messageerror'|'idle'} type
     * @param {Function} cb
     */
    removeEventListener(type: "message" | "error" | "messageerror" | "idle", cb: Function): void;
    set onresize(cb: Function | null);
    /**
     * onresize handler called when the pool is resized and workers are terminated/added.
     * Receives an event object: `{ data: { type: 'pool:resize', terminated: Array<number>, added: number, minSize, maxSize } }`
     * @type {Function|null}
     */
    get onresize(): Function | null;
    set onmessage(cb: Function | null);
    /**
     * onmessage handler called when any worker posts a message.
     * @type {Function|null}
     */
    get onmessage(): Function | null;
    set onerror(cb: Function | null);
    /**
     * onerror handler called when a worker emits an error.
     * @type {Function|null}
     */
    get onerror(): Function | null;
    set onidle(cb: Function | null);
    /**
     * onidle handler called when the pool becomes idle.
     * @type {Function|null}
     */
    get onidle(): Function | null;
    /**
     * Pause dequeueing from the internal task queue.
     * Queued tasks remain in the queue until `resumeQueue()` is called.
     * This is useful for controlled backpressure when downstream consumers
     * are temporarily unable to accept more work.
     */
    pauseQueue(): void;
    /**
     * Resume dequeueing from the internal task queue and attempt to dispatch
     * waiting tasks to available workers.
     */
    resumeQueue(): void;
    /**
     * Alias for `pauseQueue()` to provide a simpler public API.
     */
    pause(): void;
    /**
     * Alias for `resumeQueue()` to provide a simpler public API.
     */
    resume(): void;
    /**
     * Whether queued dispatch is currently paused.
     * @returns {boolean}
     */
    get queuePaused(): boolean;
    /**
     * Dispatch queued tasks to available workers when the queue is not paused.
     * @private
     */
    private _dispatchQueuedTasks;
    [Symbol.dispose](): void;
    /**
     * Asynchronous disposal hook. Drains outstanding work and then terminates.
     * Use `await pool[Symbol.asyncDispose]()` in environments that support it.
     */
    [Symbol.asyncDispose](): Promise<void>;
}
export type WorkerLike = import("./jsdoc-types.js").WorkerLike;
export type WorkerObj = import("./jsdoc-types.js").WorkerObj;
/**
 * PostMessage and pending-response typedefs are defined centrally to avoid
 * duplication across multiple helper modules. Import aliases are used here
 * so typedoc and editors can resolve the shape while keeping local docs
 * concise.
 */
export type PostMessageOptions = import("./jsdoc-types.js").PostMessageOptions;
export type PendingResponseEntry = import("./jsdoc-types.js").PendingResponseEntry;
export type PowerPoolOptions = import("./jsdoc-types.js").PowerPoolOptions;
import { PowerQueue } from './powerQueue.js';
import { PowerEventBus } from './powerEventBus.js';
import { PowerLogger } from './powerLogger.js';
