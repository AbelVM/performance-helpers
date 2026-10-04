/**
 * PowerPoolShutdownError
 *
 * Error thrown when the `PowerPool` is shut down and pending tasks are rejected.
 *
 * Carries `code === 'ERR_POOL_TERMINATED'`, the same code the pool uses for the
 * synchronous throw from a dispatch method on a shut-down pool. Both mean the
 * same thing — the pool is finished, so is the work — and `guides/errors.md`
 * tells callers to branch on `err.code`. Without it, a caller awaiting a
 * response at shutdown got an error with no code and fell through the
 * documented `switch` to `default`, which is the case most likely to be hit:
 * shutting down is exactly when pending promises are still outstanding.
 * `name` is unchanged, so `err.name === 'PowerPoolShutdownError'` keeps
 * working.
 *
 * @class PowerPoolShutdownError
 * @extends {Error}
 * @public
 */
export class PowerPoolShutdownError extends Error {
    constructor(message?: string);
    code: string;
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
     * @param {number} [options.maxQueueLength=Infinity] - Hard cap on queued tasks. With the default `queuePolicy: 'enqueue'` and no cap, a saturated pool grows its queue until the process runs out of memory; a cap makes the overflow observable instead - the incoming task is refused (`false`, or `ERR_POOL_QUEUE_FULL` when awaiting a response). `drop-oldest` still evicts the oldest to make room.
     * @param {number} [options.maxDrainWaiters=100] - Cap on concurrent `drain()` waits, so a caller that drains in a loop cannot accumulate unbounded `idle` listeners. (Internally `DEFAULT_MAX_DRAIN_WAITERS`; not exported.)
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
    _maxQueueLength: number;
    _maxDrainWaiters: number;
    /**
     * Number of `drain()` calls currently *waiting* for idle. Each one holds an
     * `idle` listener, so this is the bound that keeps a caller draining in a
     * loop from accumulating listeners without limit. See
     * `DEFAULT_MAX_DRAIN_WAITERS`.
     * @type {number}
     */
    _drainWaiters: number;
    _createdAt: number;
    _totalWorkersCreated: number;
    _totalTasksCompleted: number;
    _postFailures: number;
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
     * - `'negotiated'` starts out identical to `'framed'` and upgrades **per
     *   worker**: a worker that advertises the native carrier with
     *   `announceCapabilities()` is sent the structured-clone carrier instead,
     *   which preserves `Map`, `Set`, `Date`, `BigInt` and cycles that the JSON
     *   frame silently destroys. Workers that do not advertise keep getting the
     *   frame, so a pool can be switched on before any worker is ready.
     *
     * @type {'framed'|'legacy'|'negotiated'}
     */
    _messageCodec: "framed" | "legacy" | "negotiated";
    /**
     * Whether this runtime can structured-clone at all. Checked once here so
     * `'negotiated'` on a runtime without `structuredClone` degrades to the
     * framed path rather than throwing per message.
     */
    _nativeCloneAvailable: boolean;
    /**
     * Terminal flag. Set by `shutdown()` / `terminate()`; once true the pool
     * refuses to dispatch, enqueue or grow, so a late `postMessage()` cannot
     * resurrect it (which previously created a worker with no reaper
     * interval, pinning the Node.js process).
     * @type {boolean}
     */
    _terminated: boolean;
    _logger: PowerLogger;
    _pendingResponses: Map<any, any>;
    _underlyingToWorkerObj: Map<any, any>;
    _defaultAwaitResponseTimeout: number;
    _reaperInterval: any;
    _encodeCache: Map<any, any>;
    _encodeCacheLimit: number;
    _encodeCacheByteLimit: number;
    _encodeCacheBytes: number;
    _idempotencyTtlMs: number;
    _idempotency: Map<any, any> | null;
    _idempotencyLookups: number;
    _idempotencyDuplicatesInFlight: number;
    _idempotencyDuplicatesSettled: number;
    _idempotencyExpired: number;
    _idempotencySize: number;
    _autoScaleBackoffMultiplier: number | undefined;
    _adaptiveLimit: number | undefined;
    _longEwmaLatency: any;
    _minLatencyWindow: number | undefined;
    _lastAdaptiveLimit: number | undefined;
    _congestion: boolean | undefined;
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
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
     * Resolve a deferred message into the carrier this specific worker expects.
     *
     * This is where protocol negotiation is decided, and the reason it has to be
     * here rather than in `_prepareForTransfer` is that the target worker is not
     * known when a message is prepared: a queued item can be handed to any worker
     * by either drain site. Deciding at dispatch is what makes the decision
     * *per worker*, which is the whole point — a pool with one upgraded worker
     * and nine legacy ones is the state this feature exists for.
     *
     * Non-deferred items pass straight through, so `'framed'`, `'legacy'` and
     * every binary message keep their existing path untouched.
     *
     * @private
     * @param {import('./jsdoc-types.js').WorkerObj} obj - Target worker, if known.
     * @param {{message: *, transfer: (TransferList|undefined), deferred?: boolean}} prepared
     * @returns {{message: *, transfer: (TransferList|undefined)}}
     */
    private _encodeForWorker;
    /**
     * Wrap a deferred message in the native envelope, or return `null` when this
     * runtime cannot do it.
     *
     * The transfer list is the subtle part. A transfer list names buffers inside
     * the object being posted, and `postMessage` **detaches** them — so naming
     * the caller's buffers would detach the caller's data, which is a data-loss
     * bug that looks like a successful post. When the payload carries no binary
     * there is nothing to name, and the envelope is posted with no list and no
     * copy: the platform clones it, which is the whole reason for choosing this
     * carrier. When it does carry binary, a private copy is made first and *its*
     * buffers are transferred.
     *
     * @private
     * @param {PreparedItem} prepared - Already framed or marked `deferred`.
     * @returns {{message: object, transfer: (TransferList|undefined)}|null}
     */
    private _encodeNativeForWorker;
    /**
     * Record what a worker says it can decode, and announce the change.
     *
     * The rules here are deliberately conservative, because a worker that
     * over-claims costs a broken message and a worker that under-claims costs
     * nothing but speed:
     *
     * - `native` is only granted when the runtime can structured-clone. A worker
     *   that advertises it on a runtime that cannot is talking about a carrier
     *   that does not exist here, and honouring that would throw per message.
     * - `json` is always retained. It is what the pool sends until this
     *   announcement lands, and a worker that claims `native` alone has not said
     *   it can read the messages it has already been sent.
     *
     * @private
     * @param {import('./jsdoc-types.js').WorkerObj} obj
     * @param {{codecs: string[]}} announcement
     */
    private _applyCapabilities;
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
     * Report a failed `postMessage` and clean up the pending response for it.
     *
     * Single choke point for the failure half of `_postToWorkerObj`, so the two
     * posting paths (direct to the underlying worker, through the wrapper) cannot
     * drift on what the caller is told. The important property is that a
     * post that failed *after* possibly detaching buffers is still reported with
     * its **original** error - never with a downstream `DataCloneError` from a
     * retry against the same buffers.
     *
     * @param {any} err - The error thrown by `postMessage`.
     * @param {boolean} wantResponse - Whether the caller is awaiting a response.
     * @param {string|undefined} correlationKey - Pending-response key to reject.
     * @param {Promise<any>} pendingPromise - The caller's pending promise.
     * @param {{scope: string}} [info] - Debug-log scope.
     * @returns {Promise<any>|boolean} `pendingPromise` when awaiting a response,
     *   `false` otherwise - matching `postMessage`'s contract.
     * @private
     */
    /**
     * Post one prepared item to one worker, and account for it.
     *
     * The single dispatch choke point. There were eight `postMessage` call sites
     * before this, each with its own copy of the post-and-account sequence, and
     * they drifted in four different directions:
     *
     * - the single-worker batch fast path skipped the deferred encode, so every
     *   batched request reached the worker as raw JSON and failed at the first line
     *   (`POOL-001` — `unsupported protocol version 123`, since `{` is 123);
     * - the inline drain in `worker.onmessage` never recorded which worker took the
     *   task, so a queued `awaitResponse` promise could never be settled
     *   (`POOL-002`);
     * - `stopThePress` enqueued the caller's object with no preparation at all
     *   (`POOL-003`);
     * - only the direct path reported a failed post through `_failPost`, and only
     *   the batch loops and `broadcast` had their own idle-state policy.
     *
     * All three defects were *the same defect*. A property is checkable only when
     * there is one place that owns it, so a fourth copy of a sequence is a fourth
     * place to forget a step.
     *
     * @private
     * @param {*} workerObj - A `WorkerObj`. Left untyped to match the other
     *   private dispatch helpers here; annotating it stricter than what the worker
     *   records actually are would add an error at every call site for no gain.
     * @param {PreparedItem} prepared - Must be prepared. A `deferred` item is
     *   framed here, which is why every route can hand one over unchanged.
     * @param {{correlationId?: (string|undefined), startTime?: (number|undefined)}=} options
     *   `correlationId` for a task awaiting a response, so the pending entry can be
     *   tied to this worker; `startTime` when the caller already took a timestamp
     *   and wants every record in a batch or a broadcast to share it.
     * @returns {number} The `startTime` used, for a caller that has not taken one.
     */
    private _dispatchToWorker;
    /**
     * Report a batched post that could not be dispatched.
     *
     * `postMessageBatch` answers with a per-item boolean, so a failure is a
     * `false` in an array and — before this — nothing else. Two of the three
     * failure sites caught the error and dropped it on the floor: no log, no
     * `pool:error` event, no count. A caller seeing `false` could not tell a
     * dispatch failure from a busy worker, and an operator had no way to know a
     * batch had silently lost half its items. The third site already logged and
     * emitted, which is the pattern; this gives all three one, and adds the count.
     *
     * Every step is individually guarded because this runs **inside a `catch`**:
     * a logger or an event bus that throws would replace the original failure with
     * its own, and the item would be reported as neither failed nor sent.
     *
     * @param {any} err - The error thrown while dispatching.
     * @param {string} scope - Which site failed, for the log and the event.
     * @returns {false} So a call site can assign it straight to its result slot.
     * @private
     */
    private _reportPostFailure;
    /**
     * Report a failed `postMessage` and clean up the pending response for it.
     * @param {any} err - The error thrown by `postMessage`.
     * @param {boolean} wantResponse - Whether the caller is awaiting a response.
     * @param {string|undefined} correlationKey - Pending-response key to reject.
     * @param {Promise<any>} pendingPromise - The caller's pending promise.
     * @param {{scope: string}} [info] - Debug-log scope.
     * @returns {Promise<any>|boolean} `pendingPromise` when awaiting a response,
     *   `false` otherwise - matching `postMessage`'s contract.
     * @private
     */
    private _failPost;
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
     * Resolve and validate the per-item correlation ids for a batch that expects
     * responses.
     *
     * Two failure modes are checked, and both are checked *before* any dispatch:
     *
     * 1. A duplicate **within** the batch. A `correlationIdFactory` is caller
     *    code; a constant or a sloppy one returns the same id twice, and the
     *    second `postMessage` under a live key rejects the first waiter and
     *    takes the key over. The caller would hold a batch where one promise is
     *    already rejected and the last result resolves for all of them.
     * 2. A collision with an id that is **already in flight** from an earlier
     *    call. Same mechanism, same outcome, and it is silently the caller's
     *    fault because the factory is a global naming scheme, not a local one.
     *
     * @param {{message:*,transfer?:Transferable[]}[]} items - The batch items.
     * @param {Function} factory - The caller's `correlationIdFactory`.
     * @returns {string[]} One validated id per item, positionally aligned.
     * @throws {Error} `ERR_POOL_DUPLICATE_CORRELATION_ID` on the first collision.
     * @private
     */
    private _resolveBatchCorrelationIds;
    /**
     * Reserve room for `count` more tasks in the task queue, honouring
     * `maxQueueLength` and the configured `queuePolicy`.
     *
     * Without a cap this is a no-op and returns `count`, which is what keeps the
     * pre-2.0 behaviour intact: `queuePolicy: 'enqueue'` grew the queue until the
     * process ran out of memory, with no event and no error. The cap exists to
     * make that overflow *observable*, so the interesting decision is **which
     * task gets refused**:
     *
     * - `drop-oldest` keeps its documented meaning: evict the oldest to make room
     *   for the newest, so the queue length never exceeds the cap.
     * - every other policy refuses the **incoming** task. That is the honest
     *   reading of a caller-provided bound - the newest arrival is the one that
     *   did not fit, and refusing it keeps the work already accepted.
     *
     * @param {number} count - How many tasks are about to be queued.
     * @returns {number} How many of them may be queued. The remainder must be
     *   refused by the caller.
     * @private
     */
    private _reserveQueueSlots;
    /**
     * Enqueue or reject a prepared message according to the configured queue policy.
     * Returns `pendingPromise`/`true`/`false` to match `postMessage` semantics.
     *
     * @param {PreparedItem} prepared - Already prepared by `_prepareForTransfer`
     *   or `prepareBuffers`. Taking the item whole is deliberate: a signature of
     *   `(message, transfer)` would let a caller hand in an unprepared object,
     *   which is the shape of the POOL-003 defect.
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
     * Reject every pending response that was dispatched to a worker that is being
     * retired. The response for those tasks lives in that worker and is never
     * coming, so the promise is settled here rather than on its timeout.
     *
     * Scans the pending map rather than keeping a per-worker index, because the
     * number of outstanding responses is small and bounded by
     * `awaitResponseTimeout`, while the index would have to be maintained on the
     * response path too — and a per-worker index that is updated in one place and
     * not another silently under-rejects, which is the failure this exists to
     * prevent.
     *
     * @param {number|string|null} workerId - The worker being retired.
     * @param {string} [reason] - Why, used in the error message only.
     * @returns {number} How many pending responses were rejected.
     * @private
     */
    private _rejectPendingForWorker;
    /**
     * Record which worker a pending response was dispatched to, so retirement
     * can find it. Stamped after the post succeeds: a response that never left
     * the pool is not owed anything by the worker it was aimed at.
     *
     * @param {string|number|null|undefined} correlationKey - The pending key.
     * @param {number|string|null} workerId - The worker that received the task.
     * @returns {void}
     * @private
     */
    private _markPendingWorker;
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
     * ## `clone` defaults to `false`, and the slice it avoided was the expensive part
     *
     * `clone: true` copied every encoded buffer (`u8.slice()`) so it could be
     * **transferred** rather than copied by the structured clone. That looked like
     * the fast path: a transfer is zero-copy, so the copy must be worth avoiding.
     *
     * It is not, and it is not close. Over a Zipf-ish repeat mix of 200
     * 200-byte messages, comparing one variable at a time:
     *
     * | path | per message |
     * |---|---:|
     * | encode + cache, `slice()`, transfer (the old default) | 2942 ns |
     * | encode + cache, hand the cached buffer over to be copied | **1557 ns** |
     * | encode every time, `slice()`, transfer (no cache) | 3441 ns |
     *
     * The explicit `slice()` costs ~1385 ns — a JS-level `memcpy` of the whole
     * payload — and the structured-clone copy it was avoiding is a *native* one.
     * Paying an interpreted copy to dodge a native copy loses, and by enough that
     * it roughly halves the cost of the message path.
     *
     * The encode cache is emphatically **not** the problem: dropping it costs
     * ~1900 ns, nearly twice what the slice costs. It stays.
     *
     * With `clone: false` the cached buffer is handed to `postMessage` and the
     * runtime copies it, so the cache entry is never detached. The old warning to
     * "do NOT transfer those buffers if `clone:false`" is now the only rule, and
     * it is honoured automatically: the transfer list is `undefined` in this mode.
     *
     * Pass `{ clone: true }` to get a private transferable copy back — the
     * right choice when the caller wants to keep the payload alive on this side
     * and hand a detachable buffer to the worker.
     *
     * @param {Array<any|{message:any,transfer?:Transferable[]}>} items
     * @param {{clone?:boolean}=} options - `clone` defaults to `false`; see above.
     * @returns {PreparedItem[]}
     */
    prepareBuffers(items: Array<any | {
        message: any;
        transfer?: Transferable[];
    }>, options?: {
        clone?: boolean;
    } | undefined): PreparedItem[];
    /**
     * Class-level helper to prepare a message and optional transfer list for posting to a worker.
     * Accepts `opts` with `zeroCopy` flag to control forwarding of raw buffers.
     *
     * The single preparation path. `prepareBuffers` used to be a third copy of this
     * logic and drifted from it — see {@link PreparedItem} for what that cost.
     *
     * @private
     * @returns {PreparedItem}
     */
    private _prepareForTransfer;
    /**
     * Encode a plain-object message as a framed JSON body.
     *
     * Split out of `_prepareForTransfer` so the deferred (`'negotiated'`) path and
     * the direct path share one implementation: two copies of the transfer-list
     * munging would drift, and the transfer list is where a leak lives.
     *
     * @private
     * @param {object} msg
     * @param {TransferList|undefined} tr
     * @returns {PreparedItem}
     */
    private _frameObjectForTransfer;
    /**
     * Decrement the global active task counter safely.
     * Ensures the counter never goes negative and centralizes error handling.
     *
     * **The `Math.max(0, …)` clamp is a mitigation, not a fix.** It stops the
     * counter going negative, but it cannot stop a *double* decrement from
     * counting as a single one, and that is the live hazard: `removeWorker`/
     * `resize`/`stopThePress` drain `workerObj.tasks` in one go, and a `message`
     * already in flight from a worker being terminated arrives afterwards and
     * decrements again. The count then falls below the number of tasks actually
     * running, so `getStats().activeTasks` under-reports, `_isIdle` can go true
     * while work is outstanding, and `drain()` resolves early against a pool that
     * is not idle.
     *
     * The real fix is per-task idempotency: hand each dispatched task a token
     * from a monotonic sequence, record it on the worker, and decrement only when
     * a completion actually consumes a token that was outstanding. A late message
     * then finds nothing to consume and is correctly ignored. This used to be
     * described by a `_taskTokenSeq` field on this class that nothing ever read,
     * which asserted a mechanism that did not exist; the field is gone and the
     * work is recorded as BUG-011 rather than implied to be done.
     *
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
     * Create a new worker for this pool, wrapped for the current runtime.
     *
     * **This returns the `WorkerAgnostic` wrapper, not the raw native worker**
     * (WRK-004). It used to return `WorkerAgnostic.create(...)` — the class's
     * *static* helper, which resolves the source and hands back the bare native
     * worker — so the pool then wired `message`/`error`/`messageerror` itself,
     * with its own rule for pulling a payload out of an event. That left the
     * library with two event-normalisation implementations, and they disagreed
     * exactly where it mattered: the pool's rule was `e?.data !== undefined ?
     * e.data : e`, which is right for a browser `MessageEvent` and **wrong for
     * Node**, because `worker.on('message', value)` delivers the payload itself.
     * A worker replying with `{ data: rows, id: 7 }` therefore reached
     * `awaitResponse` as `rows` — every sibling field silently dropped, no error,
     * no counter. Verified against a real `worker_threads` worker; see
     * `test/powerPool.workerAgnostic.test.js`, which pins both runtimes.
     *
     * `WorkerAgnostic` has one rule and it is the right one in both: unwrap
     * `.data` only where the platform wraps a value in an event, and never on the
     * EventEmitter model, where there is no wrapper to unwrap.
     *
     * Creation still resolves the same way and still throws the same errors, so
     * the pool's own `workerSource` validation (and `WorkerAgnostic`'s) are
     * unchanged by this.
     *
     * @private
     * @returns {WorkerAgnostic} The wrapper; `.worker` is the raw native worker.
     * @throws {Error} When `workerSource` is invalid or worker construction fails.
     */
    private _createWorkerInstance;
    /**
     * Report a worker event handler that threw.
     *
     * The pool's own `message`/`error` handlers guard every caller-supplied
     * callback individually, so anything arriving here is a bug in this file
     * rather than in user code — an unhandled decode failure, a throw from a
     * capability announcement. It goes to the logger and the debug log and
     * nowhere else: **not** to `_bus.emit('pool:error')`, because this runs
     * *inside* the dispatch loop that emit would re-enter, and a second failure
     * inside error reporting is the one outcome worse than the original.
     *
     * Without a handler here the failure would be silent, which is the defect
     * WRK-003 recorded for this class: a listener that stops being called looks
     * exactly like a worker that went quiet.
     *
     * @param {*} err - What the handler threw.
     * @param {{type?: string, listener?: Function}} [context] - Which event.
     * @private
     * @returns {void}
     */
    private _onWorkerListenerError;
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
     * Claim an idempotency key, or report that it is already claimed.
     *
     * **In-flight versus settled is the decision this ledger exists to get right.**
     * A key is marked `in-flight` when the post is accepted for dispatch and moves
     * to `settled` once the task is on its way — so the two cases are
     * distinguishable, and both are refusals with different meanings:
     *
     * - `in-flight` means a **concurrent duplicate**: the first post has not been
     *   sent yet, so refusing is free and nothing has been applied twice.
     * - `settled` means a **retry**: the task was dispatched, may already have run,
     *   and refusing is the only thing standing between a caller retrying across a
     *   timeout and applying a side effect twice.
     *
     * Collapsing the two — one `seen` set, the usual shape — loses the ability to
     * say which happened, and it also loses the ability to release the key when a
     * post is refused before dispatch. `settled` carries a timestamp so the ledger
     * can expire it; `in-flight` does not, because an in-flight claim is released
     * by the post's own outcome rather than by time.
     *
     * @private
     * @param {string|number|undefined} key - `undefined` disables the ledger for
     *   this post.
     * @param {number} now - From `nowMs()`, so one post reads one clock.
     * @returns {boolean} `true` to proceed, `false` if the key is already claimed.
     */
    private _idempotencyBegin;
    /**
     * Move a claimed key from in-flight to settled.
     *
     * @private
     * @param {string|number|undefined} key - Coerced with `String()`, as the pool
     *   coerces every idempotency key.
     * @param {number} now
     */
    private _idempotencySettle;
    /**
     * Drop a claim for a post that was never dispatched.
     *
     * @private
     * @param {string|number|undefined} key
     */
    private _idempotencyRelease;
    /**
     * Expire settled keys older than the TTL, examining a bounded slice per call.
     *
     * Bounded on purpose: an unbounded scan on the post path would make the cost of
     * opting in proportional to the size of the ledger, which is the opposite of
     * what the option is for. A rotating cursor means every entry is eventually
     * reached — the ledger drains at a bounded rate rather than never.
     *
     * `in-flight` entries are never expired. They are released by their post's own
     * outcome, and expiring one would let a still-running task be posted a second
     * time — the exact double-apply this feature is for.
     *
     * @private
     * @param {number} now
     */
    private _idempotencySweep;
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
     * `postMessage` without the POOL-013 ledger wrapper.
     *
     * Split out so the ledger sees one return value per post rather than the eight
     * the decision is spread across, and so the settled/release pair cannot be
     * forgotten on one path.
     *
     * @private
     * @param {*} message
     * @param {Transferable[]=} transfer
     * @param {PostMessageOptions=} options
     * @returns {boolean|Promise<any>}
     */
    private _postMessageInner;
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
     * @param {{recreateWorkers?: boolean}&PostMessageOptions=} options
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
     * @param {PostMessageOptions&{correlationIdFactory?: function(number): (string|number)}=} options - Optional options forwarded to each `postMessage` call.
     * @returns {(boolean|Promise<any>)[]}
     * @throws {Error} When `items` is not an array.
     */
    postMessageBatch(items: {
        message: any;
        transfer?: Transferable[];
    }[], options?: (PostMessageOptions & {
        correlationIdFactory?: (arg0: number) => (string | number);
    }) | undefined): (boolean | Promise<any>)[];
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
     * **The signal is end-to-end task latency, and Netflix's is queueing delay.**
     * That is the same quantity only for a uniform workload. For a pool whose
     * tasks vary in cost, `vegas`' `minRtt / currentRtt` and `aimd`'s
     * `shortRtt / longRtt` test conflate "queueing appeared" with "a heavier task
     * ran", and the controller will cut concurrency for work that was simply
     * expensive. Measured against a fixed limit this is untested either way —
     * `bench/claims.js` has no mode for it.
     *
     * **The `aimd` policy here is delay-shaped, despite the name.** Netflix's
     * `AIMDLimit` is loss-based; this branches on RTT divergence, the same shape
     * as `gradient2`. The loss-based AIMD in this library is
     * `PowerBackpressure._aimdStep`. See ADR 0005 for the full signal taxonomy.
     *
     * @returns {number} The updated limit.
     * @private
     */
    /**
     * How many workers this tick's scale action should move, given how far
     * latency currently sits from `targetMs`.
     *
     * **The thresholds in `_autoScaleTick` still decide the direction.** This only
     * sets the magnitude, inside the caller's existing `stepUp` / `stepDown`
     * ceiling — which is why nothing changes at the default `stepUp: 1`: a ceiling
     * of one worker is one worker, whatever the controller says.
     *
     * Before this, the step was a fixed count. A pool that was 20 % over target
     * added as many workers as one that was 300 % over, so the badly-over case
     * converged no faster than the marginal one. A PI controller on the relative
     * error scales the step by how far off the setpoint actually is, and its
     * integral term is what removes the residual: this is a *discrete* stepper, so
     * proportional action alone leaves a standing offset, which is exactly the
     * property `PowerServo`'s "converges to a setpoint a fixed gain cannot" test
     * pins.
     *
     * Normalised, not absolute: `measured` is `ewma / targetMs` against a setpoint
     * of `1`, so the gains are dimensionless and do not have to be retuned when
     * `targetMs` changes. Only `|output|` is used — the sign is already settled by
     * the hysteresis band and the queue-pressure check.
     *
     * `PowerServo` owns no timer, so `dt` is passed in; the tick's own
     * `intervalMs` is the right unit because that is the interval this runs on.
     *
     * @param {number} ewma - Current latency EWMA in ms.
     * @param {number} targetMs - Configured target.
     * @param {number} ceiling - `stepUp` or `stepDown`; the caller's hard limit.
     * @param {number} dtSeconds - Tick interval in seconds, for the integral.
     * @returns {number} A worker count in `[1, ceiling]`.
     */
    _autoscaleSteps(ewma: number, targetMs: number, ceiling: number, dtSeconds: number): number;
    _updateAdaptiveLimit(): number | undefined;
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
    /** @type {PowerServo|null} */
    _autoscaleServo: PowerServo | null | undefined;
    /**
     * Emit the pool-idle synthetic message to `onmessage` and listeners.
     *
     * The emitted event object is
     * `{ data: { type: 'pool:idle', workers, stats } }`, where:
     *
     * - `data.workers` is the per-worker snapshot the pool is actually idle *by*:
     *   an array of `{ id, tasks, lastActive }`. A worker with `tasks !== 0` here
     *   means `_activeTasks` has drifted from the per-worker counts.
     * - `data.stats` is the aggregate `getStats()` summary (`queueLength`,
     *   `activeTasks`, `performance`, ...).
     *
     * Both are computed lazily and both used to be called "stats". The payload
     * was always the `getStats()` *summary* while the JSDoc described an
     * *array*, so a listener written against the documentation did
     * `ev.data.stats.map(w => w.id)` and got a `TypeError` on a busy pool - the
     * per-worker array simply was not reachable. Naming them for what they are is
     * the fix; the summary keeps the `stats` key so existing readers of
     * `ev.data.stats` are unaffected.
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
     * Build the idle event object. Both payloads are computed lazily (via
     * getters) so the `getStats()` allocation (which maps over all workers) is
     * skipped on idle transitions when no listener actually reads them.
     * @private
     * @returns {{data:{type:string,workers:{id:number,tasks:number,lastActive:number}[],stats:object}}}
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
     *
     * The wait is bounded three ways, and every one of them **abandons the wait,
     * never the work** - the pool keeps dispatching and keeps serving every other
     * caller. That is the contract `drain()` has always had; what is new is that
     * the wait can actually be given up on without leaking anything:
     *
     * - `signal` - an `AbortSignal` rejects with its reason. `AbortError` unless
     *   the caller aborted with their own `Error`.
     * - `timeout` - rejects with `ERR_POOL_DRAIN_TIMEOUT` after `timeout` ms.
     *   Without it a drain against a wedged worker waits forever, which is
     *   indistinguishable from a hang.
     * - `maxDrainWaiters` (constructor option) - rejects with
     *   `ERR_POOL_DRAIN_TOO_MANY_WAITERS` once too many are already waiting.
     *
     * Previously only `signal` existed, and it leaked: `raceWithAbort` rejected
     * the returned promise but left the `idle` listener attached, so an aborted
     * drain retained a closure and a listener slot until the pool happened to go
     * idle again. This implementation owns the listener lifecycle directly and
     * detaches on *every* exit path.
     *
     * @param {object} [options]
     * @param {AbortSignal} [options.signal] - Abandons the wait when aborted.
     * @param {number} [options.timeout] - Abandons the wait after this many ms.
     * @returns {Promise<object>} Promise resolving to `getStats()`.
     */
    drain(options?: {
        signal?: AbortSignal | undefined;
        timeout?: number | undefined;
    }): Promise<object>;
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
export type TransferList = import("./jsdoc-types.js").TransferList;
/**
 * A message on its way to a worker, after preparation but before it is posted.
 *
 * `deferred` is the load-bearing member, and it is what the batch path was
 * missing. `true` means the encode was **deliberately not done** and the framing
 * is still owed, so the dispatch site must frame before posting. It is set when
 * the encode cannot safely be shared — an object message under `messageCodec:
 * 'negotiated'`, where the carrier is a per-worker decision, or under
 * `prepareBuffers`' default `clone: false`, where a cached body cannot be both
 * shared and correct on the wire.
 *
 * Posting a `deferred` item verbatim is a protocol error, not a slow path: the
 * worker reads the first byte of raw JSON — `{`, or 123 — as a protocol version
 * and rejects the message. Every dispatch site therefore has to check this, which
 * is why the member is on the type rather than being a local variable at each
 * one.
 */
export type PreparedItem = {
    /**
     * - The value to post. A `Uint8Array` under a framing codec,
     * the original object when `deferred`.
     */
    message: any;
    /**
     * - Must be `undefined` whenever
     * `message` is a shared buffer: a transfer list detaches its entries, and a
     * detached cache entry is the bug `clone` exists to avoid.
     */
    transfer: TransferList | undefined;
    /**
     * - Framing is still owed; see above.
     */
    deferred?: boolean | undefined;
};
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
import { PowerServo } from './powerServo.js';
