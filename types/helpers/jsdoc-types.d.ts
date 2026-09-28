/**
 * Options accepted by `postMessage`, `postMessageBatch` and `broadcast` helpers.
 */
export type PostMessageOptions = {
    /**
     * - If true, returns a Promise resolved when a response with a matching `correlationId` is received.
     */
    awaitResponse?: boolean | undefined;
    /**
     * - Timeout in milliseconds for `awaitResponse` promises. If omitted, the caller or pool default is used.
     */
    timeout?: number | undefined;
    /**
     * - Optional id of the target worker to prefer when dispatching the message.
     */
    workerId?: string | number | undefined;
    /**
     * - When true and the message is a plain object, attempt zero-copy transfer (encode to `Uint8Array` and transfer its buffer).
     */
    zeroCopy?: boolean | undefined;
};
/**
 * Entry used to track pending responses for `awaitResponse` callers.
 */
export type PendingResponseEntry = {
    /**
     * - Resolve function for the pending Promise.
     */
    resolve: (arg0: any) => void;
    /**
     * - Reject function for the pending Promise.
     */
    reject: (arg0: any) => void;
    /**
     * - Optional timeout
     * handle used to cancel the pending request. Spelled as
     * `ReturnType<typeof setTimeout>` rather than `NodeJS.Timeout`: the latter is a
     * Node-only global, so naming it made this declaration fail to compile for
     * any consumer without `@types/node`. `clearTimeout` accepts the handle in
     * both runtimes, and the project unrefs it, so only "something clearTimeout
     * takes" is actually being promised.
     */
    timer?: number | null | undefined;
};
/**
 * Common pool options that may be re-used across helpers.
 */
export type CommonPoolOptions = {
    minSize?: number | undefined;
    maxSize?: number | undefined;
    idleTimeout?: number | undefined;
    taskQueue?: boolean | undefined;
};
/**
 * PowerPool-specific options used to configure worker pools.
 * This mirrors the options accepted by `PowerPool` and is centralized
 * so other helpers can reference the same shape without duplication.
 */
export type PowerPoolOptions = {
    size?: number | undefined;
    minSize?: number | undefined;
    maxSize?: number | undefined;
    workerOptions?: Object | undefined;
    maxTasksPerWorker?: number | undefined;
    idleTimeout?: number | undefined;
    taskQueue?: boolean | undefined;
    queuePolicy?: "enqueue" | "drop-oldest" | "drop-newest" | "reject" | undefined;
    lazy?: boolean | undefined;
    debugLevel?: number | undefined;
    listenerMaxListeners?: number | undefined;
    weakListeners?: boolean | undefined;
    queueHighThreshold?: number | undefined;
    /**
     * - Hard cap on queued tasks. `Infinity`
     * (the default) keeps the pre-2.0 behaviour where `queuePolicy: 'enqueue'`
     * grows without bound. With a finite cap the *incoming* task is the one that
     * is refused, because a cap is what the caller asked for; `drop-oldest` is
     * the exception and still evicts the oldest to make room for the newest.
     * A refused task returns `false`, or rejects with `ERR_POOL_QUEUE_FULL` when
     * the caller is awaiting a response.
     */
    maxQueueLength?: number | undefined;
    /**
     * - Cap on concurrent `drain()` waits.
     * Beyond it, `drain()` rejects with `ERR_POOL_DRAIN_TOO_MANY_WAITERS`
     * instead of accumulating an unbounded number of `idle` listeners.
     */
    maxDrainWaiters?: number | undefined;
    /**
     * - Adaptive
     * concurrency. `true` enables the default `ewma` policy; an object configures
     * it. Typed as `AutoScaleOptions` rather than `Object` because the pool reads
     * `aimdBeta`, `backoffFactor`, `cooldownMs` and friends straight off it, and a
     * bare `Object` turned every one of those into an error at the use site.
     */
    autoScale?: boolean | AutoScaleOptions | undefined;
    /**
     * - Default timeout (ms) for
     * `awaitResponse` when a call does not pass its own.
     */
    awaitResponseTimeout?: number | undefined;
    /**
     * - Tasks slower than this (ms) are
     * counted for the slow-task / `pool:slow` signal.
     */
    slowTaskThreshold?: number | undefined;
    /**
     * - Cap on registered pool listeners before
     * the `MaxListenersExceededWarning` path is taken.
     */
    maxListeners?: number | undefined;
    /**
     * - Wire protocol for
     * object messages. `'framed'` (default since 2.0) posts a `PowerMessageCodec`
     * envelope; `'legacy'` restores the 1.x bare-JSON framing for a worker that
     * has not migrated yet. See the migration note in `guides/powerPool.md`.
     */
    messageCodec?: "framed" | "legacy" | undefined;
};
/**
 * Adaptive-concurrency configuration for `PowerPool` (`autoScale`).
 *
 * Typed as a named typedef rather than a bare `Object` so the properties the
 * pool reads are checked where it reads them.
 */
export type AutoScaleOptions = {
    policy?: "ewma" | "aimd" | "vegas" | "gradient2" | undefined;
    intervalMs?: number | undefined;
    targetMs?: number | undefined;
    alpha?: number | undefined;
    cooldownMs?: number | undefined;
    hysteresis?: number | undefined;
    limitMin?: number | undefined;
    limitMax?: number | undefined;
    backoffFactor?: number | undefined;
    backoffMaxMultiplier?: number | undefined;
    backoffResetMs?: number | undefined;
    longWindowAlpha?: number | undefined;
    aimdBeta?: number | undefined;
};
/**
 * /**
 *  A worker-like object: the intersection of what a browser `Worker`, a Node
 *  `worker_threads.Worker`, and this library's own `WorkerAgnostic` expose.
 *
 *  Typed because the worker was previously just `object`, which made
 *  `addEventListener`, `onmessage` and `terminate` non-existent properties
 *  wherever a worker was held - and made every assignment to a worker field
 *  unchecked, so handing a plain `{}` to a pool would type-check and then fail
 *  at the first message.
 *
 *  Every member is optional except `postMessage`: a real worker always has it,
 *  while the event API is present on some shapes and not others, and a property
 *  assignment (`worker.onmessage = ...`) is how the oldest of them are wired.
 */
export type WorkerLike = {
    postMessage: (arg0: any, arg1: (ArrayBuffer[] | ArrayBufferView[] | Object) | undefined) => any;
    terminate?: (() => (Promise<void> | void)) | undefined;
    addEventListener?: ((arg0: string, arg1: (...args: any[]) => void) => any) | undefined;
    removeEventListener?: ((arg0: string, arg1: (...args: any[]) => void) => any) | undefined;
    on?: ((arg0: string, arg1: (...args: any[]) => void) => any) | undefined;
    off?: ((arg0: string, arg1: (...args: any[]) => void) => any) | undefined;
    onmessage?: ((...arg0: any[]) => void) | undefined;
    onerror?: ((...arg0: any[]) => void) | undefined;
    onmessageerror?: ((...arg0: any[]) => void) | undefined;
    importScripts?: ((...arg0: any[]) => void) | undefined;
};
/**
 * /**
 *  A transferable list: an array of buffers/views, or any array-like of them.
 *
 *  Spelled without a bare `Object` member on purpose - the pool reads `.length`
 *  off the transfer list, and a `Object` in the union makes that an error at
 *  every call site. An array-like is the honest widening: the code also accepts
 *  iterables and converts them once.
 */
export type TransferList = ArrayBuffer[] | ArrayBufferView[] | {
    length: number;
};
/**
 * Worker object shape used internally by `PowerPool`.
 */
export type WorkerObj = {
    /**
     * - Numeric id for the worker entry.
     */
    id: number;
    /**
     * - The underlying Worker instance or worker-like object.
     */
    worker: WorkerLike;
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
    _startTimes?: import("./powerQueue.js").PowerQueue | number[] | undefined;
};
/**
 * Deferred promise options for `PowerDefer`.
 */
export type PowerDeferOptions = {
    autoReject?: boolean | undefined;
};
/**
 * Observer options for `PowerObserver`.
 */
export type PowerObserverOptions = {
    map?: Function | undefined;
    distinct?: boolean | undefined;
    async?: boolean | "microtask" | "macrotask" | undefined;
};
/**
 * Retry helper options used by `PowerRetry`.
 */
export type PowerRetryOptions = {
    /**
     * - Total attempts, including the first.
     * Must be `>= 1`; a `0` or negative value throws rather than resolving to 1.
     */
    maxAttempts?: number | undefined;
    /**
     * -
     * The delay curve. `decorrelated` is the AWS random-walk form, where each
     * delay is drawn against the *previous* delay rather than a formula. An
     * unrecognised value throws.
     */
    backoff?: "exponential" | "linear" | "fixed" | "decorrelated" | undefined;
    baseDelay?: number | undefined;
    maxDelay?: number | undefined;
    /**
     * - Randomise within `[0.5 * delay, delay]`.
     * Rejected at `false` when `backoff` is `decorrelated`, which is defined as
     * randomised.
     */
    jitter?: boolean | undefined;
    retryIf?: ((err: any) => boolean) | undefined;
    onRetry?: ((attempt: number, err: any, delay: number) => void) | undefined;
    /**
     * - Per-attempt timeout in ms. When set,
     * `fn` receives the attempt's `AbortSignal`, and a timed-out attempt is
     * **not** retried: the caller asked for that bound, and retrying would
     * multiply it by `maxAttempts`.
     */
    attemptTimeout?: number | undefined;
    /**
     * - A
     * retry budget. A `PowerRetryBudget` bounds retry traffic across calls; a
     * number is a ratio, which builds a bucket scoped to this call only. `0.2`
     * permits retries up to 20 % of request volume.
     */
    budget?: number | import("./powerRetry.js").PowerRetryBudget | undefined;
    /**
     * - Milliseconds to wait on the **first**
     * attempt before sending a duplicate. The first to succeed wins and the
     * loser is aborted. `0` disables hedging. Only a hedge draws the budget a
     * token; a refused budget means no hedge rather than a failed attempt.
     */
    hedgeDelay?: number | undefined;
};
/**
 * Options for `PowerRetryBudget`.
 */
export type PowerRetryBudgetOptions = {
    /**
     * - Retry tokens granted per request, in
     * `(0, 1]`. 0.2 is the top of the 10-20 % band the Google SRE *Handling
     * Overload* chapter recommends. Values above 1 throw: a budget permitting
     * more retries than requests is the amplification it exists to prevent.
     */
    ratio?: number | undefined;
    /**
     * - Ceiling on stored tokens, which is the
     * burst allowance. A capacity of 1 would refuse the first retry of a fresh
     * budget, engaging the protection on a healthy dependency.
     */
    capacity?: number | undefined;
};
/**
 * A snapshot of a `PowerRetryBudget`.
 */
export type PowerRetryBudgetStats = {
    ratio: number;
    capacity: number;
    /**
     * - Retry tokens left right now.
     */
    available: number;
    /**
     * - Requests recorded via `recordRequest()`.
     */
    requests: number;
    /**
     * - Tokens actually spent on retries and hedges.
     */
    retries: number;
    /**
     * - Retries and hedges the budget denied.
     */
    refused: number;
};
/**
 * The rejection `PowerRetry.run` produces when a single attempt exceeds
 * `attemptTimeout`.
 *
 * A named type because all three fields are read by callers - `code` to tell a
 * timeout from a genuine failure, and `attempts`/`attemptTimeout` to know which
 * attempt gave up and how long it was allowed - and none of them are on `Error`.
 */
export type RetryTimeoutError = Error & {
    code: "ETIMEOUT";
    attempts: number;
    attemptTimeout: number;
};
/**
 * Latch options for `PowerLatch`.
 */
export type PowerLatchOptions = {
    onAbort?: ((reason: any) => void) | undefined;
};
/**
 * A single pending `wait()` call registered in `PowerLatch`'s waiter map.
 *
 * Named rather than inlined so the map value, the object built in `wait()` and
 * the two teardown paths (`_removeWaiter`, `_settleAll`) are all checked
 * against the same shape. `timer` and `signalHandler` are nullable because they
 * are only set when the corresponding option was passed.
 */
export type PowerLatchWaiter = {
    /**
     * - Monotonic id used as the map key.
     */
    token: number;
    /**
     * - Holds the waiter's
     * promise, resolved or rejected when the latch settles.
     */
    defer: import("./powerDefer.js").PowerDefer;
    /**
     * - Timeout handle, or
     * `null` when `wait()` was called without a timeout.
     */
    timer?: number | null | undefined;
    /**
     * - `abort` listener, or `null` when
     * `wait()` was called without a signal.
     */
    signalHandler?: (() => void) | null | undefined;
    /**
     * - Signal being watched, or `null`.
     */
    signal?: AbortSignal | null | undefined;
};
/**
 * The argument accepted by `PowerLatch.wait()`: a bare timeout in ms, or an
 * options object. Spelled out instead of `object` so `timeout` and `signal` are
 * checked where they are read.
 */
export type PowerLatchWaitOptions = {
    /**
     * - Reject with `code: 'ETIMEOUT'` after this many ms.
     */
    timeout?: number | undefined;
    /**
     * - Reject with the signal's reason on abort.
     */
    signal?: AbortSignal | undefined;
};
/**
 * A listener callback, as `PowerEventBus` and `PowerSubscriberSet` call it.
 *
 * Spelled as a rest signature rather than `(payload:any)=>void` because
 * `PowerSubscriberSet.addOnce` forwards whatever it was called with, so the
 * set cannot promise the bus's single-payload shape to its own callers.
 */
export type SubscriberListener = (...args: any[]) => void;
/**
 * What a `PowerSubscriberSet` actually stores: the listener itself in strong
 * mode, a `WeakRef` to it in weak mode. Every read goes through `_deref`,
 * which is why the stored and yielded shapes differ.
 */
export type SubscriberEntry = SubscriberListener | WeakRef<SubscriberListener>;
/**
 * Event bus options for `PowerEventBus`.
 */
export type PowerEventBusOptions = {
    /**
     * Cap on listeners per event; `0` (the
     * default) is unlimited.
     */
    maxListeners?: number | undefined;
    /**
     * Store listeners behind `WeakRef`, so a listener
     * that is no longer referenced elsewhere can be collected.
     */
    weak?: boolean | undefined;
};
/**
 * The token `PowerEventBus` hands its `FinalizationRegistry`: the event whose
 * bucket held the listener, plus the ref to unregister when it dies.
 */
export type EventBusWeakToken = {
    event: string;
    ref: WeakRef<SubscriberListener>;
};
/**
 * Throttle options for `PowerThrottle`.
 *
 * The defaults live here rather than in a `@param {number} [options.capacity=1]`
 * line next to the constructor: TypeScript rejects a qualified name in a
 * `@param` that is not declared as `{object}` in the same block, so those lines
 * could not coexist with a named options type at all.
 */
export type PowerThrottleOptions = {
    /**
     * Maximum tokens in the bucket.
     */
    capacity?: number | undefined;
    /**
     * Initial tokens. Defaults to `capacity`.
     */
    tokens?: number | undefined;
    /**
     * Tokens added per second.
     */
    refillRate?: number | undefined;
    /**
     * Bookkeeping interval in milliseconds.
     */
    refillInterval?: number | undefined;
};
/**
 * A reservation returned by `PowerThrottle.reserve()`, and the only thing
 * `release()` / `rollback()` read off a token-shaped argument.
 *
 * Named so `release(tokenOrN)` can declare `PowerThrottleToken | number`
 * instead of `object | number`: a bare `object` has no `n`, so reading it was
 * an error at the one place the token is actually used.
 */
export type PowerThrottleToken = {
    /**
     * - Tokens reserved, to be returned to the bucket.
     */
    n: number;
};
/**
 * Batch options for `PowerBatch`.
 */
export type PowerBatchOptions = {
    /**
     * Flush as soon as this many items are queued.
     */
    maxSize?: number | undefined;
    /**
     * How the batch is scheduled.
     */
    scheduling?: "microtask" | "macrotask" | undefined;
};
/**
 * The promise `PowerBatch` hands back to every `add()`/`flush()` caller in a
 * batch, plus the handles that settle it once the handler has run.
 *
 * Named so the field is `BatchPending | null` rather than the comment
 * `{ promise, resolve, reject }` it used to carry - a comment is not a type, so
 * `this._pending` was inferred from its initialiser alone and every
 * `this._pending.resolve()` was an error.
 */
export type BatchPending = {
    promise: Promise<void>;
    resolve: (value?: any) => void;
    reject: (reason?: any) => void;
};
/**
 * Queue options for `PowerQueue`.
 */
export type PowerQueueOptions = {
    initialCapacity?: number | undefined;
};
/**
 * Queue options for `PowerTTLMap`.
 */
export type PowerTTLMapOptions = {
    /**
     * Default TTL in ms (0 = no expiry).
     */
    defaultTTL?: number | undefined;
    onExpire?: ((key: any, value: any) => void) | undefined;
};
/**
 * What `PowerTTLMap` stores per key: the value plus the absolute `nowMs()` at
 * which it lapses. `expiresAt` is `0`, not `Infinity`, for a key with no TTL -
 * the falsy value is the "never expires" test at every read site.
 */
export type TTLMapEntry = {
    value: any;
    expiresAt: number;
};
/**
 * Sliding-window options for `PowerSlidingWindow`.
 */
export type PowerSlidingWindowOptions = {
    /**
     * Max events allowed in window.
     */
    capacity?: number | undefined;
    /**
     * Window size in milliseconds.
     */
    windowMs?: number | undefined;
};
/**
 * Logger options for `PowerLogger`.
 */
export type PowerLoggerOptions = {
    format?: "text" | "json" | undefined;
    name?: string | undefined;
    formatter?: ((payload: PowerLoggerPayload) => string | PowerLoggerPayload | null) | undefined;
    output?: ((payload: PowerLoggerPayload | string) => void) | undefined;
};
/**
 * The structured record `PowerLogger` builds and hands to `formatter` and to an
 * `output` sink.
 *
 * Named because `_emit` builds it as an object literal and then both adds
 * `name` to it conditionally and *replaces* it wholesale with whatever
 * `formatter` returns - so an inline shape could never have described it: `name`
 * did not exist on it, and the formatter's `Object` return was not assignable
 * back to it.
 *
 * `level` is the textual label ('error', 'warn', ...) rather than the numeric
 * threshold that gates it, and `format` echoes the sink's own mode so a sink can
 * format for itself.
 */
export type PowerLoggerPayload = {
    level: string;
    /**
     * - The resolved log arguments: the sole argument when
     * there was one, otherwise the whole array.
     */
    msg: any;
    /**
     * - `nowMs()` at emit time.
     */
    ts: number;
    format: "text" | "json";
    /**
     * - The logger's `name`, when it has one.
     */
    name?: string | undefined;
};
/**
 * Extra per-call switches `_emit` accepts. `msgArray` forces `msg` to stay an
 * array even when a single argument was passed, which is what `table()` needs.
 */
export type PowerLoggerEmitOptions = {
    msgArray?: boolean | undefined;
};
/**
 * The console methods `_emit` dispatches to by name. A union rather than
 * `string`, so indexing `Console` with the name is checked instead of falling
 * back to an implicit `any`.
 */
export type PowerLoggerConsoleMethod = "error" | "warn" | "info" | "log" | "debug";
/**
 * Options for `PowerEventLoopMonitor`.
 */
export type EventLoopMonitorOptions = {
    /**
     * How often to schedule the probe timer.
     * Smaller catches shorter blocks and costs more; the drift is recorded per
     * probe, so 20ms means "worst block seen between two probes 20ms apart".
     */
    intervalMs?: number | undefined;
    /**
     * Target relative error for the
     * drift histogram's quantiles. Forwarded to `PowerHistogram`.
     */
    relativeAccuracy?: number | undefined;
    /**
     * Called with each drift sample
     * in milliseconds, for hook-based alerting. A throwing hook is swallowed:
     * it must not be able to stop the monitor.
     */
    onDrift?: ((arg0: number) => void) | null | undefined;
    /**
     * Passed through to the internal
     * timer, which is `unref()`d by default. Set `true` to hold the Node process
     * open while monitoring.
     */
    keepProcessAlive?: boolean | undefined;
    /**
     * Supplies `utilization()` instead of resolving Node's `perf_hooks`. The
     * argument exists so a browser build, a bundler, or a test can provide the
     * reading without this module reaching for a Node built-in.
     */
    utilizationProvider?: (() => ({
        active: number;
        idle: number;
        utilization: number;
    })) | null | undefined;
};
/**
 * The idempotent release callback handed out by the permit-gate family
 * (`PowerPermitGate`, `PowerSemaphore`, `PowerBackpressure`).
 *
 * Named so those helpers can promise a callable. All three previously published
 * `Function` / `Promise<Function>`, and `Function` carries no call signature, so
 * it is not assignable to `() => void` - which made `PowerSemaphore.acquire()`
 * unable to return what its own gate returns, and made the documented
 * `.then((release) => release())` not type-check for a consumer.
 */
export type PowerReleaseFn = () => void;
/**
 * The rejection `PowerBulkhead.reset()` hands to every queued waiter.
 *
 * `code` is stamped on it (`ERR_BULKHEAD_RESET` unless the caller's reason
 * already carried one) so a caller can tell a bulkhead teardown from a genuine
 * task failure - which `Error` alone cannot.
 */
export type BulkheadResetError = Error & {
    code?: string;
};
/**
 * Options accepted by `PowerBulkhead.reset()` / `dispose()`.
 */
export type PowerBulkheadResetOptions = {
    /**
     * Permits to restore per partition. Defaults to
     * `maxConcurrency`.
     */
    available?: number | undefined;
    /**
     * Rejection reason for queued waiters.
     */
    reason?: string | Error | undefined;
};
/**
 * Bulkhead construction options.
 */
export type PowerBulkheadOptions = {
    /**
     * Number of isolated execution partitions.
     */
    partitions?: number | undefined;
    /**
     * Maximum concurrent tasks per partition.
     */
    maxConcurrency?: number | undefined;
    /**
     * Maximum queued tasks across all
     * partitions.
     */
    queueCapacity?: number | undefined;
    /**
     * Maps a key to a partition index.
     */
    partitioner?: ((key: any) => number) | undefined;
    /**
     * Invoked whenever a user-supplied
     * `release()` or task hook throws. Added in 2.0; without it those failures were
     * silently discarded, because the field was read but never assigned.
     */
    onError?: ((err: any) => void) | undefined;
};
/**
 * AIMD settings for `PowerBackpressure` (`adaptive`).
 *
 * Disabled by default: the pre-2.0 behaviour, a constant `refillAmount`, is
 * unchanged unless asked for.
 */
export type BackpressureAdaptiveOptions = {
    /**
     * Set `false` to keep the constants but
     * leave AIMD off - useful for turning it off without unsetting the tuning.
     */
    enabled?: boolean | undefined;
    /**
     * Permits added per refill tick that
     * finds consumers draining. TCP adds one segment per round trip; here a tick
     * is the unit of observation.
     */
    additiveIncrease?: number | undefined;
    /**
     * Multiplicative decrease factor, clamped to
     * `(0.1, 0.99)`. 0.5 is TCP's.
     */
    beta?: number | undefined;
    /**
     * Floor for the refill amount. Never probes with
     * less than one permit, so a backoff cannot deadlock the queue.
     */
    min?: number | undefined;
    /**
     * Ceiling, so a permanently fast consumer
     * cannot drive the window past capacity on its own. The refill is still
     * capped by the number of missing permits.
     */
    max?: number | undefined;
};
/**
 * Circuit options for `PowerCircuit`.
 */
export type PowerCircuitOptions = {
    /**
     * Consecutive failures before the circuit opens.
     */
    threshold?: number | undefined;
    /**
     * **Base** milliseconds the circuit stays
     * open before a trial call is allowed. Consecutive trips grow this
     * exponentially and jitter the result, so a fleet of clients does not probe
     * one dependency in lockstep; the first trip uses this value unchanged.
     */
    timeout?: number | undefined;
    /**
     * Ceiling for the grown open window. Defaults
     * to `timeout * 16`.
     */
    maxTimeout?: number | undefined;
    /**
     * - Called as
     * `(state, reason)` on every transition. `reason` is one of `success`,
     * `thresholdExceeded`, `timeoutElapsed`, `trialFailed`, `reset` or
     * `hub-closed`.
     */
    onStateChange?: ((state: string, reason?: string) => void) | undefined;
    /**
     * - When
     * given, transitions are also emitted on it as `stateChange`.
     */
    eventBus?: import("./powerEventBus.js").PowerEventBus | undefined;
};
/**
 * The three states a `PowerCircuit` moves between.
 */
export type CircuitState = "closed" | "open" | "half-open";
/**
 * The rejection `PowerCircuit.call()` throws while the circuit is open.
 *
 * A named type because the `code` is the documented contract - the guide and
 * `powerCircuit.test.js` both branch on `err.code === 'ECIRCUITOPEN'` - and an
 * `Error` does not carry one.
 */
export type CircuitOpenError = Error & {
    code: "ECIRCUITOPEN";
};
/**
 * Buffer encoder/decoder adapters used by `powerBuffer` helpers when
 * falling back to Node `Buffer` or abstracting TextEncoder/TextDecoder.
 */
export type BufferEncoder = {
    encode: (s: string) => Uint8Array;
};
export type BufferDecoder = {
    decode: (u8: Uint8Array) => string;
};
/**
 * Node / in-memory cache node shape used by `PowerCache`.
 */
export type CacheNode = {
    key: any;
    value: any;
    weight: number;
    expiresAt: number;
    prev: CacheNode | null;
    next: CacheNode | null;
};
/**
 * Options accepted by `PowerCache`.
 */
export type PowerCacheOptions = {
    maxEntries?: number | undefined;
    maxWeight?: number | undefined;
    weightFn?: ((arg0: any) => number) | null | undefined;
    defaultTTL?: number | undefined;
    maxPoolSize?: number | undefined;
    rejectOversized?: boolean | undefined;
    onEvict?: ((arg0: any, arg1: any, arg2: string) => void) | null | undefined;
    onExpire?: ((arg0: any, arg1: any) => void) | null | undefined;
    initialPoolSize?: number | undefined;
    maxCleanupPerTick?: number | undefined;
    eagerCleanupOnRead?: boolean | undefined;
    /**
     * - Default timeout (ms) applied to
     * `getOrSetAsync` when a caller omits its own `timeout`.
     */
    defaultAsyncTimeout?: number | undefined;
    /**
     * - Invoked as `onError(err, message)`
     * whenever an internal failure is swallowed: a throwing `onEvict`/`onExpire`
     * callback, or a failing `weightFn`.
     */
    onError?: ((arg0: any, arg1: string) => void) | null | undefined;
    /**
     * - Admission filter in front
     * of the eviction policy. `'tinylfu'` runs a 4-bit Count-Min frequency
     * sketch and refuses an insert when the entry it would evict is still wanted,
     * which is what makes a cache survive a one-off scan. Only consulted at
     * capacity, and a tie keeps the incumbent.
     */
    admission?: "none" | "tinylfu" | undefined;
    /**
     * - Eviction policy. `'slru'` (opt-in) splits
     * the list into probation and protected segments and promotes on access, which
     * resists a one-off sequential scan. Defaults to `'lru'`.
     */
    policy?: "lru" | "slru" | undefined;
};
/**
 * A memoized wrapper returned by `PowerMemoizer.memoize()`.
 *
 * Callable exactly like the function it wraps, and carrying the cache helpers
 * plus a link back to the original. Declaring the return type as `Function`
 * broke both halves for consumers: `Function` has no call signature (so
 * `memoized(1)` was not assignable to anything) and none of the attached
 * properties, so `memoized.original` did not exist as far as TypeScript was
 * concerned - even though both have always worked at runtime.
 */
export type MemoizedFunction<F extends Function> = F & {
    get: (arg0: string) => any;
    has: (arg0: string) => boolean;
    delete: (arg0: string) => boolean;
    clear: () => void;
    stats: () => Object;
    cache: Object;
    original: F;
};
/**
 * Options for the PowerChunking helper.
 */
export type PowerChunkingOptions = {
    poolOptions?: PowerPoolOptions | undefined;
    postOptions?: PostMessageOptions | undefined;
    chunkSize?: number | undefined;
    fnComplexity?: "light" | "medium" | "heavy" | undefined;
};
/**
 * Options for the PowerDeadline helper.
 */
export type PowerDeadlineOptions = {
    maxAttempts?: number | undefined;
    attemptTimeout?: number | undefined;
    totalTimeout?: number | undefined;
    retryDelay?: number | undefined;
    retryIf?: ((err: any) => boolean) | undefined;
    signal?: AbortSignal | undefined;
    onRetry?: ((attempt: number, err: any, delay: number) => void) | undefined;
    backoff?: "exponential" | "linear" | "fixed" | undefined;
    baseDelay?: number | undefined;
    maxDelay?: number | undefined;
    jitter?: boolean | undefined;
};
