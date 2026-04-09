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
     * - Optional timeout handle used to cancel the pending request.
     */
    timer?: number | NodeJS.Timeout | null;
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
 * Event bus options for `PowerEventBus`.
 */
export type PowerEventBusOptions = {
    maxListeners?: number | undefined;
    weak?: boolean | undefined;
};
/**
 * Throttle options for `PowerThrottle`.
 */
export type PowerThrottleOptions = {
    capacity?: number | undefined;
    tokens?: number | undefined;
    refillRate?: number | undefined;
    refillInterval?: number | undefined;
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
 * Options for `PowerTTLMap`.
 */
export type PowerTTLMapOptions = {
    onExpire?: ((key: any, value: any) => void) | undefined;
};
/**
 * Sliding-window options for `PowerSlidingWindow`.
 */
export type PowerSlidingWindowOptions = {
    capacity?: number | undefined;
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
    weightFn?: ((arg0: any) => number) | undefined;
    defaultTTL?: number | undefined;
    maxPoolSize?: number | undefined;
    rejectOversized?: boolean | undefined;
    onEvict?: ((arg0: any, arg1: any, arg2: string) => void) | undefined;
    onExpire?: ((arg0: any, arg1: any) => void) | undefined;
    initialPoolSize?: number | undefined;
    maxCleanupPerTick?: number | undefined;
    eagerCleanupOnRead?: boolean | undefined;
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
