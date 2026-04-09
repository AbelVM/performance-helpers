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
}
/**
 * @typedef {Object} WorkerObj
 * @property {number} id - Numeric id for the worker entry.
 * @property {Worker} worker - The underlying Worker instance or worker-like object.
 * @property {number} tasks - Number of active tasks currently assigned.
 * @property {number} lastActive - Timestamp (ms) of last activity on this worker.
 * @property {number|null} [latencyEwma] - EWMA of historical task latency (ms).
 * @property {number[]|PowerQueue} [_startTimes] - Queue of start timestamps for inflight tasks (ms).
 */
/**
 * @typedef {Object} PostMessageOptions
 * @property {boolean} [awaitResponse] - If true, returns a Promise resolved when a response with a matching `correlationId` is received.
 * @property {number} [timeout] - Timeout in milliseconds for `awaitResponse` promises. If omitted, the pool's default is used.
 * @property {number|string} [workerId] - Optional id of the target worker to prefer when dispatching the message. If omitted, the pool chooses the least-loaded worker.
 * @property {boolean} [zeroCopy] - When true and the message is a plain object, attempt zero-copy transfer (use internal encoding to a Uint8Array and transfer its buffer).
 */
/**
 * @typedef {Object} PendingResponseEntry
 * @property {function(any):void} resolve - Function to resolve the pending Promise with the worker response.
 * @property {function(any):void} reject - Function to reject the pending Promise with an error.
 * @property {number|NodeJS.Timeout|null} [timer] - Optional timeout handle used to cancel the pending request.
 */
/**
 * @typedef {Object} PowerPoolOptions
 * @property {number} [size] - Initial number of workers to create when `lazy` is false.
 * @property {number} [minSize] - Minimum number of workers to keep alive.
 * @property {number} [maxSize] - Maximum number of workers allowed in the pool. Coerced to be at least `minSize`.
 * @property {Object} [workerOptions] - Options forwarded to the underlying `Worker` constructor when using a string path.
 * @property {number} [maxTasksPerWorker] - Soft capacity per worker used during task dispatch.
 * @property {number} [idleTimeout] - Milliseconds after which idle workers beyond `minSize` are terminated.
 * @property {boolean} [taskQueue] - Whether to queue tasks when all workers are busy.
 * @property {'enqueue'|'drop-oldest'|'drop-newest'|'reject'} [queuePolicy='enqueue'] - Queue overflow behavior when the pool is saturated.
 * @property {boolean} [lazy] - If true, defer creating workers up to `size` until demand; only `minSize` workers are created at construction.
 * @property {number} [debugLevel] - Debug verbosity level for internal logging.
 * @property {number} [listenerMaxListeners]
 * @property {boolean} [weakListeners]
 * @property {number} [queueHighThreshold] - Optional threshold; when `queue.length > queueHighThreshold` the pool emits a `pool:queue:high` event on the internal bus.
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
    [x: number]: () => void;
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
    } | null;
    _autoScaleInterval: number | null;
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
    _correlationCounter: number;
    /** number of currently active (dispatched) tasks across all workers */
    _activeTasks: number;
    /** whether the pool is considered idle (no active tasks and empty queue) */
    _isIdle: boolean;
    /** whether queued dispatch is paused */
    _queuePaused: boolean;
    _logger: PowerLogger;
    _pendingResponses: Map<any, any>;
    _underlyingToWorkerObj: Map<any, any>;
    _defaultAwaitResponseTimeout: number;
    _reaperInterval: number;
    _encodeCache: Map<any, any>;
    _encodeCacheLimit: number;
    _encodeCacheByteLimit: number;
    _encodeCacheBytes: number;
    _autoScaleBackoffMultiplier: number | undefined;
    /**
     * Log debug information about swallowed errors when debug logging is enabled.
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
     * @private
     */
    private _postToWorkerObj;
    /**
     * Attempt to grow the pool by adding a worker and dispatching the message.
     * Preserves the same pending-response cleanup semantics as inline logic.
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
     * Clear lifecycle timer intervals used by the pool.
     * @private
     */
    private _clearLifecycleIntervals;
    /**
     * Shutdown the pool: clear timers, reject pending responses, terminate workers,
     * and clear internal queues. This is a full stop that prevents background
     * timers from keeping the process alive.
     */
    shutdown(): void;
    /**
     * Encode a plain object to a Uint8Array, using a small cache to avoid
     * repeated encoding work for identical messages. Returns a Uint8Array.
     * @private
     * @param {Object} obj
     * @returns {Uint8Array}
     */
    private _encodeForTransfer;
    /**
     * Prepare a transferable Uint8Array for the given object.
     * Returns a new Uint8Array when `clone` is true (safe to transfer), or
     * the cached Uint8Array when `clone` is false (do not transfer the returned buffer).
     * @param {Object} obj
     * @param {{clone?:boolean}=} options
     * @returns {Uint8Array}
     */
    prepareBuffer(obj: Object, options?: {
        clone?: boolean;
    } | undefined): Uint8Array;
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
     * Generate a safe correlation id. Prefer `crypto.randomUUID()` when
     * available, otherwise fall back to a timestamp + random suffix.
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
    private _emitIdle;
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
    drain(): Promise<object>;
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
}
export type WorkerObj = {
    /**
     * - Numeric id for the worker entry.
     */
    id: number;
    /**
     * - The underlying Worker instance or worker-like object.
     */
    worker: Worker;
    /**
     * - Number of active tasks currently assigned.
     */
    tasks: number;
    /**
     * - Timestamp (ms) of last activity on this worker.
     */
    lastActive: number;
    /**
     * - EWMA of historical task latency (ms).
     */
    latencyEwma?: number | null | undefined;
    /**
     * - Queue of start timestamps for inflight tasks (ms).
     */
    _startTimes?: number[] | PowerQueue | undefined;
};
export type PostMessageOptions = {
    /**
     * - If true, returns a Promise resolved when a response with a matching `correlationId` is received.
     */
    awaitResponse?: boolean | undefined;
    /**
     * - Timeout in milliseconds for `awaitResponse` promises. If omitted, the pool's default is used.
     */
    timeout?: number | undefined;
    /**
     * - Optional id of the target worker to prefer when dispatching the message. If omitted, the pool chooses the least-loaded worker.
     */
    workerId?: string | number | undefined;
    /**
     * - When true and the message is a plain object, attempt zero-copy transfer (use internal encoding to a Uint8Array and transfer its buffer).
     */
    zeroCopy?: boolean | undefined;
};
export type PendingResponseEntry = {
    /**
     * - Function to resolve the pending Promise with the worker response.
     */
    resolve: (arg0: any) => void;
    /**
     * - Function to reject the pending Promise with an error.
     */
    reject: (arg0: any) => void;
    /**
     * - Optional timeout handle used to cancel the pending request.
     */
    timer?: number | NodeJS.Timeout | null;
};
export type PowerPoolOptions = {
    /**
     * - Initial number of workers to create when `lazy` is false.
     */
    size?: number | undefined;
    /**
     * - Minimum number of workers to keep alive.
     */
    minSize?: number | undefined;
    /**
     * - Maximum number of workers allowed in the pool. Coerced to be at least `minSize`.
     */
    maxSize?: number | undefined;
    /**
     * - Options forwarded to the underlying `Worker` constructor when using a string path.
     */
    workerOptions?: Object | undefined;
    /**
     * - Soft capacity per worker used during task dispatch.
     */
    maxTasksPerWorker?: number | undefined;
    /**
     * - Milliseconds after which idle workers beyond `minSize` are terminated.
     */
    idleTimeout?: number | undefined;
    /**
     * - Whether to queue tasks when all workers are busy.
     */
    taskQueue?: boolean | undefined;
    /**
     * - Queue overflow behavior when the pool is saturated.
     */
    queuePolicy?: "enqueue" | "drop-oldest" | "drop-newest" | "reject" | undefined;
    /**
     * - If true, defer creating workers up to `size` until demand; only `minSize` workers are created at construction.
     */
    lazy?: boolean | undefined;
    /**
     * - Debug verbosity level for internal logging.
     */
    debugLevel?: number | undefined;
    listenerMaxListeners?: number | undefined;
    weakListeners?: boolean | undefined;
    /**
     * - Optional threshold; when `queue.length > queueHighThreshold` the pool emits a `pool:queue:high` event on the internal bus.
     */
    queueHighThreshold?: number | undefined;
};
import { PowerQueue } from './powerQueue.js';
import { PowerEventBus } from './powerEventBus.js';
import { PowerLogger } from './powerLogger.js';
