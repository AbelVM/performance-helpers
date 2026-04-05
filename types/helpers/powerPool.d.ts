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
 * pool.onmessage = (e) => { logger.log(e.data); };
 * pool.postMessage({ payload: {} });
 */
export class PowerPool {
    [x: number]: () => void;
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
    constructor(workerSource: Function | string, options?: {
        size?: number | undefined;
        minSize?: number | undefined;
        maxSize?: number | undefined;
        workerOptions?: Object | undefined;
        maxTasksPerWorker?: number | undefined;
        idleTimeout?: number | undefined;
        taskQueue?: boolean | undefined;
    });
    _workerSource: string | Function;
    _workerOptions: Object;
    _maxTasksPerWorker: number;
    minSize: number;
    maxSize: number;
    idleTimeout: number;
    taskQueueEnabled: boolean;
    _createdAt: number;
    _totalWorkersCreated: number;
    _totalTasksCompleted: number;
    _taskDurationsWelfordCount: number;
    _taskDurationsWelfordMean: number;
    _taskDurationsWelfordM2: number;
    _taskDurationsMin: number;
    _taskDurationsMax: number;
    _terminatedWorkerTaskCountsTotal: number;
    _terminatedWorkerTaskCountsCount: number;
    /** @type {WorkerObj[]} */
    workers: WorkerObj[];
    queue: PowerQueue;
    _listeners: {
        message: Set<any>;
        error: Set<any>;
        messageerror: Set<any>;
        idle: Set<any>;
        resize: Set<any>;
    };
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
    _logger: PowerLogger;
    _reaperInterval: number;
    _pendingResponses: Map<any, any>;
    _nextCorrelationId: number;
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
     */
    private _createWorkerInstance;
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
     * @returns {boolean} True if the message was accepted (dispatched or queued).
     */
    postMessage(message: any, transfer?: Transferable[] | undefined, options: any): boolean;
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
     * Return stats for debugging.
     * @returns {{status:{id:number,tasks:number,lastActive:number}[],performance:Object}}
     */
    getStats(): {
        status: {
            id: number;
            tasks: number;
            lastActive: number;
        }[];
        performance: Object;
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
    _startTimes?: number[] | undefined;
};
import { PowerQueue } from './powerQueue.js';
import { PowerLogger } from './powerLogger.js';
