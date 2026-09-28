/**
 * Shared JSDoc typedefs used across helper modules.
 *
 * Centralizing common option shapes avoids duplicating long param lists
 * in multiple files and keeps documentation consistent.
 */

/**
 * Options accepted by `postMessage`, `postMessageBatch` and `broadcast` helpers.
 * @typedef {Object} PostMessageOptions
 * @property {boolean} [awaitResponse] - If true, returns a Promise resolved when a response with a matching `correlationId` is received.
 * @property {number} [timeout] - Timeout in milliseconds for `awaitResponse` promises. If omitted, the caller or pool default is used.
 * @property {number|string} [workerId] - Optional id of the target worker to prefer when dispatching the message.
 * @property {boolean} [zeroCopy] - When true and the message is a plain object, attempt zero-copy transfer (encode to `Uint8Array` and transfer its buffer).
 */

/**
 * Entry used to track pending responses for `awaitResponse` callers.
 * @typedef {Object} PendingResponseEntry
 * @property {function(any):void} resolve - Resolve function for the pending Promise.
 * @property {function(any):void} reject - Reject function for the pending Promise.
 * @property {ReturnType<typeof setTimeout>|null} [timer] - Optional timeout
 *   handle used to cancel the pending request. Spelled as
 *   `ReturnType<typeof setTimeout>` rather than `NodeJS.Timeout`: the latter is a
 *   Node-only global, so naming it made this declaration fail to compile for
 *   any consumer without `@types/node`. `clearTimeout` accepts the handle in
 *   both runtimes, and the project unrefs it, so only "something clearTimeout
 *   takes" is actually being promised.
 */

/**
 * Common pool options that may be re-used across helpers.
 * @typedef {Object} CommonPoolOptions
 * @property {number} [minSize]
 * @property {number} [maxSize]
 * @property {number} [idleTimeout]
 * @property {boolean} [taskQueue]
 */

/**
 * PowerPool-specific options used to configure worker pools.
 * This mirrors the options accepted by `PowerPool` and is centralized
 * so other helpers can reference the same shape without duplication.
 * @typedef {Object} PowerPoolOptions
 * @property {number} [size]
 * @property {number} [minSize]
 * @property {number} [maxSize]
 * @property {Object} [workerOptions]
 * @property {number} [maxTasksPerWorker]
 * @property {number} [idleTimeout]
 * @property {boolean} [taskQueue]
 * @property {'enqueue'|'drop-oldest'|'drop-newest'|'reject'} [queuePolicy]
 * @property {boolean} [lazy]
 * @property {number} [debugLevel]
 * @property {number} [listenerMaxListeners]
 * @property {boolean} [weakListeners]
 * @property {number} [queueHighThreshold]
 * @property {boolean|AutoScaleOptions} [autoScale=false] - Adaptive
 *   concurrency. `true` enables the default `ewma` policy; an object configures
 *   it. Typed as `AutoScaleOptions` rather than `Object` because the pool reads
 *   `aimdBeta`, `backoffFactor`, `cooldownMs` and friends straight off it, and a
 *   bare `Object` turned every one of those into an error at the use site.
 * @property {'framed'|'legacy'} [messageCodec='framed'] - Wire protocol for
 *   object messages. `'framed'` (default since 2.0) posts a `PowerMessageCodec`
 *   envelope; `'legacy'` restores the 1.x bare-JSON framing for a worker that
 *   has not migrated yet. See the migration note in `guides/powerPool.md`.
 */

/**
 * Adaptive-concurrency configuration for `PowerPool` (`autoScale`).
 *
 * Typed as a named typedef rather than a bare `Object` so the properties the
 * pool reads are checked where it reads them.
 *
 * @typedef {Object} AutoScaleOptions
 * @property {'ewma'|'aimd'|'vegas'|'gradient2'} [policy='ewma']
 * @property {number} [intervalMs]
 * @property {number} [targetMs]
 * @property {number} [alpha]
 * @property {number} [cooldownMs]
 * @property {number} [hysteresis]
 * @property {number} [limitMin]
 * @property {number} [limitMax]
 * @property {number} [backoffFactor]
 * @property {number} [backoffMaxMultiplier]
 * @property {number} [backoffResetMs]
 * @property {number} [longWindowAlpha]
 * @property {number} [aimdBeta]
 */

/**
 * Worker object shape used internally by `PowerPool`.
 * @typedef {Object} WorkerObj
 * @property {number} id - Numeric id for the worker entry.
 * @property {Worker} worker - The underlying Worker instance or worker-like object.
 * @property {number} tasks - Number of active tasks currently assigned.
 * @property {number} lastActive - Timestamp (ms) of last activity on this worker.
 * @property {number|null} [latencyEwma] - EWMA of historical task latency (ms).
 * @property {number[]|import('./powerQueue.js').PowerQueue} [_startTimes] - Queue of start timestamps for inflight tasks (ms).
 */

export {};

/**
 * Deferred promise options for `PowerDefer`.
 * @typedef {Object} PowerDeferOptions
 * @property {boolean} [autoReject]
 */

/**
 * Observer options for `PowerObserver`.
 * @typedef {Object} PowerObserverOptions
 * @property {function} [map]
 * @property {boolean} [distinct]
 * @property {boolean|'microtask'|'macrotask'} [async]
 */

/**
 * Retry helper options used by `PowerRetry`.
 * @typedef {Object} PowerRetryOptions
 * @property {number} [maxAttempts=3]
 * @property {'exponential'|'linear'|'fixed'} [backoff='exponential']
 * @property {number} [baseDelay=100]
 * @property {number} [maxDelay=10000]
 * @property {boolean} [jitter=true]
 * @property {(err:any)=>boolean} [retryIf]
 * @property {(attempt:number, err:any, delay:number)=>void} [onRetry]
 * @property {number} [attemptTimeout]
 */

/**
 * Latch options for `PowerLatch`.
 * @typedef {Object} PowerLatchOptions
 * @property {(reason:any)=>void} [onAbort]
 */

/**
 * Event bus options for `PowerEventBus`.
 * @typedef {Object} PowerEventBusOptions
 * @property {number} [maxListeners]
 * @property {boolean} [weak]
 */

/**
 * Throttle options for `PowerThrottle`.
 * @typedef {Object} PowerThrottleOptions
 * @property {number} [capacity]
 * @property {number} [tokens]
 * @property {number} [refillRate]
 * @property {number} [refillInterval]
 */

/**
 * Batch options for `PowerBatch`.
 * @typedef {Object} PowerBatchOptions
 * @property {number} [maxSize]
 */

/**
 * Queue options for `PowerQueue`.
 * @typedef {Object} PowerQueueOptions
 * @property {number} [initialCapacity]
 */

/**
 * Options for `PowerTTLMap`.
 * @typedef {Object} PowerTTLMapOptions
 * @property {number} [defaultTTL] Default TTL in ms (0 = no expiry).
 * @property {(key:any,value:any)=>void} [onExpire]
 */

/**
 * Sliding-window options for `PowerSlidingWindow`.
 * @typedef {Object} PowerSlidingWindowOptions
 * @property {number} [capacity]
 * @property {number} [windowMs]
 */

/**
 * Logger options for `PowerLogger`.
 * @typedef {Object} PowerLoggerOptions
 * @property {'text'|'json'} [format]
 * @property {string} [name]
 * @property {(payload:Object)=>string|Object|null} [formatter]
 * @property {(payload:Object|string)=>void} [output]
 */

/**
 * Circuit options for `PowerCircuit`.
 * @typedef {Object} PowerCircuitOptions
 * @property {number} [threshold]
 * @property {number} [timeout]
 * @property {(state:string,reason?:string)=>void} [onStateChange]
 * @property {import("./powerEventBus.js").PowerEventBus} [eventBus]
 */

/**
 * Buffer encoder/decoder adapters used by `powerBuffer` helpers when
 * falling back to Node `Buffer` or abstracting TextEncoder/TextDecoder.
 * @typedef {Object} BufferEncoder
 * @property {(s:string)=>Uint8Array} encode
 */

/**
 * @typedef {Object} BufferDecoder
 * @property {(u8:Uint8Array)=>string} decode
 */

/**
 * Node / in-memory cache node shape used by `PowerCache`.
 * @typedef {Object} CacheNode
 * @property {*} key
 * @property {*} value
 * @property {number} weight
 * @property {number} expiresAt
 * @property {CacheNode|null} prev
 * @property {CacheNode|null} next
 */

/**
 * Options accepted by `PowerCache`.
 * @typedef {Object} PowerCacheOptions
 * @property {number} [maxEntries]
 * @property {number} [maxWeight]
 * @property {function(*):number} [weightFn]
 * @property {number} [defaultTTL]
 * @property {number} [maxPoolSize]
 * @property {boolean} [rejectOversized]
 * @property {function(*, *, string):void} [onEvict]
 * @property {function(*, *):void} [onExpire]
 * @property {number} [initialPoolSize]
 * @property {number} [maxCleanupPerTick]
 * @property {boolean} [eagerCleanupOnRead]
 * @property {number} [defaultAsyncTimeout] - Default timeout (ms) applied to
 *   `getOrSetAsync` when a caller omits its own `timeout`.
 * @property {function(*, string):void} [onError] - Invoked as `onError(err, message)`
 *   whenever an internal failure is swallowed: a throwing `onEvict`/`onExpire`
 *   callback, or a failing `weightFn`.
 * @property {'lru'|'slru'} [policy] - Eviction policy. `'slru'` (opt-in) splits
 *   the list into probation and protected segments and promotes on access, which
 *   resists a one-off sequential scan. Defaults to `'lru'`.
 */

/**
 * A memoized wrapper returned by `PowerMemoizer.memoize()`.
 *
 * Callable exactly like the function it wraps, and carrying the cache helpers
 * plus a link back to the original. Declaring the return type as `Function`
 * broke both halves for consumers: `Function` has no call signature (so
 * `memoized(1)` was not assignable to anything) and none of the attached
 * properties, so `memoized.original` did not exist as far as TypeScript was
 * concerned - even though both have always worked at runtime.
 *
 * @template {Function} F
 * @typedef {F & {
 *   get: function(string): any,
 *   has: function(string): boolean,
 *   delete: function(string): boolean,
 *   clear: function(): void,
 *   stats: function(): Object,
 *   cache: Object,
 *   original: F
 * }} MemoizedFunction
 */

/**
 * Options for the PowerChunking helper.
 * @typedef {Object} PowerChunkingOptions
 * @property {PowerPoolOptions} [poolOptions]
 * @property {PostMessageOptions} [postOptions]
 * @property {number} [chunkSize]
 * @property {'light'|'medium'|'heavy'} [fnComplexity]
 */

/**
 * Options for the PowerDeadline helper.
 * @typedef {Object} PowerDeadlineOptions
 * @property {number} [maxAttempts]
 * @property {number} [attemptTimeout]
 * @property {number} [totalTimeout]
 * @property {number} [retryDelay]
 * @property {(err:any)=>boolean} [retryIf]
 * @property {AbortSignal} [signal]
 * @property {(attempt:number, err:any, delay:number)=>void} [onRetry]
 * @property {'exponential'|'linear'|'fixed'} [backoff]
 * @property {number} [baseDelay]
 * @property {number} [maxDelay]
 * @property {boolean} [jitter]
 */
