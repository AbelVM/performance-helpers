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
 * @property {number|NodeJS.Timeout|null} [timer] - Optional timeout handle used to cancel the pending request.
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
