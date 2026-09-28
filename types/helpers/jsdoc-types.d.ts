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
    maxAttempts?: number | undefined;
    backoff?: "exponential" | "linear" | "fixed" | undefined;
    baseDelay?: number | undefined;
    maxDelay?: number | undefined;
    jitter?: boolean | undefined;
    retryIf?: ((err: any) => boolean) | undefined;
    onRetry?: ((attempt: number, err: any, delay: number) => void) | undefined;
    attemptTimeout?: number | undefined;
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
    maxSize?: number | undefined;
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
    formatter?: ((payload: Object) => string | Object | null) | undefined;
    output?: ((payload: Object | string) => void) | undefined;
};
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
 * Circuit options for `PowerCircuit`.
 */
export type PowerCircuitOptions = {
    threshold?: number | undefined;
    timeout?: number | undefined;
    onStateChange?: ((state: string, reason?: string) => void) | undefined;
    eventBus?: import("./powerEventBus.js").PowerEventBus | undefined;
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
