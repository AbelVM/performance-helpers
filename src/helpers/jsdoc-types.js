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
 * @property {number} [awaitResponseTimeout] - Default timeout (ms) for
 *   `awaitResponse` when a call does not pass its own.
 * @property {number} [slowTaskThreshold] - Tasks slower than this (ms) are
 *   counted for the slow-task / `pool:slow` signal.
 * @property {number} [maxListeners] - Cap on registered pool listeners before
 *   the `MaxListenersExceededWarning` path is taken.
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
/**
 * A worker-like object: the intersection of what a browser `Worker`, a Node
 * `worker_threads.Worker`, and this library's own `WorkerAgnostic` expose.
 *
 * Typed because the worker was previously just `object`, which made
 * `addEventListener`, `onmessage` and `terminate` non-existent properties
 * wherever a worker was held - and made every assignment to a worker field
 * unchecked, so handing a plain `{}` to a pool would type-check and then fail
 * at the first message.
 *
 * Every member is optional except `postMessage`: a real worker always has it,
 * while the event API is present on some shapes and not others, and a property
 * assignment (`worker.onmessage = ...`) is how the oldest of them are wired.
 *
 * @typedef {Object} WorkerLike
 * @property {function(*, (ArrayBuffer[]|ArrayBufferView[]|Object)=): *} postMessage
 * @property {function(): (Promise<void>|void)} [terminate]
 * @property {function(string, function(...*):void): *} [addEventListener]
 * @property {function(string, function(...*):void): *} [removeEventListener]
 * @property {function(string, function(...*):void): *} [on]
 * @property {function(string, function(...*):void): *} [off]
 * @property {function(...*):void} [onmessage]
 * @property {function(...*):void} [onerror]
 * @property {function(...*):void} [onmessageerror]
 * @property {function(...*):void} [importScripts]
 */

/**
/**
 * A transferable list: an array of buffers/views, or any array-like of them.
 *
 * Spelled without a bare `Object` member on purpose - the pool reads `.length`
 * off the transfer list, and a `Object` in the union makes that an error at
 * every call site. An array-like is the honest widening: the code also accepts
 * iterables and converts them once.
 *
 * @typedef {ArrayBuffer[]|ArrayBufferView[]|{length: number}} TransferList
 */

/**
 * Worker object shape used internally by `PowerPool`.
 * @typedef {Object} WorkerObj
 * @property {number} id - Numeric id for the worker entry.
 * @property {WorkerLike} worker - The underlying Worker instance or worker-like object.
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
 * The rejection `PowerRetry.run` produces when a single attempt exceeds
 * `attemptTimeout`.
 *
 * A named type because all three fields are read by callers - `code` to tell a
 * timeout from a genuine failure, and `attempts`/`attemptTimeout` to know which
 * attempt gave up and how long it was allowed - and none of them are on `Error`.
 *
 * @typedef {Error & {code: 'ETIMEOUT', attempts: number, attemptTimeout: number}} RetryTimeoutError
 */

/**
 * Latch options for `PowerLatch`.
 * @typedef {Object} PowerLatchOptions
 * @property {(reason:any)=>void} [onAbort]
 */

/**
 * A single pending `wait()` call registered in `PowerLatch`'s waiter map.
 *
 * Named rather than inlined so the map value, the object built in `wait()` and
 * the two teardown paths (`_removeWaiter`, `_settleAll`) are all checked
 * against the same shape. `timer` and `signalHandler` are nullable because they
 * are only set when the corresponding option was passed.
 *
 * @typedef {Object} PowerLatchWaiter
 * @property {number} token - Monotonic id used as the map key.
 * @property {import('./powerDefer.js').PowerDefer} defer - Holds the waiter's
 *   promise, resolved or rejected when the latch settles.
 * @property {?(ReturnType<typeof setTimeout>)} [timer] - Timeout handle, or
 *   `null` when `wait()` was called without a timeout.
 * @property {?(() => void)} [signalHandler] - `abort` listener, or `null` when
 *   `wait()` was called without a signal.
 * @property {?AbortSignal} [signal] - Signal being watched, or `null`.
 */

/**
 * The argument accepted by `PowerLatch.wait()`: a bare timeout in ms, or an
 * options object. Spelled out instead of `object` so `timeout` and `signal` are
 * checked where they are read.
 *
 * @typedef {Object} PowerLatchWaitOptions
 * @property {number} [timeout] - Reject with `code: 'ETIMEOUT'` after this many ms.
 * @property {AbortSignal} [signal] - Reject with the signal's reason on abort.
 */

/**
 * A listener callback, as `PowerEventBus` and `PowerSubscriberSet` call it.
 *
 * Spelled as a rest signature rather than `(payload:any)=>void` because
 * `PowerSubscriberSet.addOnce` forwards whatever it was called with, so the
 * set cannot promise the bus's single-payload shape to its own callers.
 *
 * @typedef {(...args:any[])=>void} SubscriberListener
 */

/**
 * What a `PowerSubscriberSet` actually stores: the listener itself in strong
 * mode, a `WeakRef` to it in weak mode. Every read goes through `_deref`,
 * which is why the stored and yielded shapes differ.
 *
 * @typedef {SubscriberListener|WeakRef<SubscriberListener>} SubscriberEntry
 */

/**
 * Event bus options for `PowerEventBus`.
 * @typedef {Object} PowerEventBusOptions
 * @property {number} [maxListeners] Cap on listeners per event; `0` (the
 *   default) is unlimited.
 * @property {boolean} [weak] Store listeners behind `WeakRef`, so a listener
 *   that is no longer referenced elsewhere can be collected.
 */

/**
 * The token `PowerEventBus` hands its `FinalizationRegistry`: the event whose
 * bucket held the listener, plus the ref to unregister when it dies.
 *
 * @typedef {Object} EventBusWeakToken
 * @property {string} event
 * @property {WeakRef<SubscriberListener>} ref
 */

/**
 * Throttle options for `PowerThrottle`.
 *
 * The defaults live here rather than in a `@param {number} [options.capacity=1]`
 * line next to the constructor: TypeScript rejects a qualified name in a
 * `@param` that is not declared as `{object}` in the same block, so those lines
 * could not coexist with a named options type at all.
 *
 * @typedef {Object} PowerThrottleOptions
 * @property {number} [capacity=1] Maximum tokens in the bucket.
 * @property {number} [tokens] Initial tokens. Defaults to `capacity`.
 * @property {number} [refillRate=0] Tokens added per second.
 * @property {number} [refillInterval=1000] Bookkeeping interval in milliseconds.
 */

/**
 * A reservation returned by `PowerThrottle.reserve()`, and the only thing
 * `release()` / `rollback()` read off a token-shaped argument.
 *
 * Named so `release(tokenOrN)` can declare `PowerThrottleToken | number`
 * instead of `object | number`: a bare `object` has no `n`, so reading it was
 * an error at the one place the token is actually used.
 *
 * @typedef {Object} PowerThrottleToken
 * @property {number} n - Tokens reserved, to be returned to the bucket.
 */

/**
 * Batch options for `PowerBatch`.
 * @typedef {Object} PowerBatchOptions
 * @property {number} [maxSize] Flush as soon as this many items are queued.
 * @property {'microtask'|'macrotask'} [scheduling] How the batch is scheduled.
 */

/**
 * The promise `PowerBatch` hands back to every `add()`/`flush()` caller in a
 * batch, plus the handles that settle it once the handler has run.
 *
 * Named so the field is `BatchPending | null` rather than the comment
 * `{ promise, resolve, reject }` it used to carry - a comment is not a type, so
 * `this._pending` was inferred from its initialiser alone and every
 * `this._pending.resolve()` was an error.
 *
 * @typedef {Object} BatchPending
 * @property {Promise<void>} promise
 * @property {(value?: any) => void} resolve
 * @property {(reason?: any) => void} reject
 */

/**
 * Queue options for `PowerQueue`.
 * @typedef {Object} PowerQueueOptions
 * @property {number} [initialCapacity]
 */

/**
 * Queue options for `PowerTTLMap`.
 * @typedef {Object} PowerTTLMapOptions
 * @property {number} [defaultTTL] Default TTL in ms (0 = no expiry).
 * @property {(key:any,value:any)=>void} [onExpire]
 */

/**
 * What `PowerTTLMap` stores per key: the value plus the absolute `nowMs()` at
 * which it lapses. `expiresAt` is `0`, not `Infinity`, for a key with no TTL -
 * the falsy value is the "never expires" test at every read site.
 *
 * @typedef {Object} TTLMapEntry
 * @property {any} value
 * @property {number} expiresAt
 */

/**
 * Sliding-window options for `PowerSlidingWindow`.
 * @typedef {Object} PowerSlidingWindowOptions
 * @property {number} [capacity=1] Max events allowed in window.
 * @property {number} [windowMs=1000] Window size in milliseconds.
 */

/**
 * Logger options for `PowerLogger`.
 * @typedef {Object} PowerLoggerOptions
 * @property {'text'|'json'} [format]
 * @property {string} [name]
 * @property {(payload:PowerLoggerPayload)=>string|PowerLoggerPayload|null} [formatter]
 * @property {(payload:PowerLoggerPayload|string)=>void} [output]
 */

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
 *
 * @typedef {Object} PowerLoggerPayload
 * @property {string} level
 * @property {any} msg - The resolved log arguments: the sole argument when
 *   there was one, otherwise the whole array.
 * @property {number} ts - `nowMs()` at emit time.
 * @property {'text'|'json'} format
 * @property {string} [name] - The logger's `name`, when it has one.
 */

/**
 * Extra per-call switches `_emit` accepts. `msgArray` forces `msg` to stay an
 * array even when a single argument was passed, which is what `table()` needs.
 *
 * @typedef {Object} PowerLoggerEmitOptions
 * @property {boolean} [msgArray]
 */

/**
 * The console methods `_emit` dispatches to by name. A union rather than
 * `string`, so indexing `Console` with the name is checked instead of falling
 * back to an implicit `any`.
 *
 * @typedef {'error'|'warn'|'info'|'log'|'debug'} PowerLoggerConsoleMethod
 */

/**
 * Options for `PowerEventLoopMonitor`.
 *
 * @typedef {Object} EventLoopMonitorOptions
 * @property {number} [intervalMs=20] How often to schedule the probe timer.
 *   Smaller catches shorter blocks and costs more; the drift is recorded per
 *   probe, so 20ms means "worst block seen between two probes 20ms apart".
 * @property {number} [relativeAccuracy=0.01] Target relative error for the
 *   drift histogram's quantiles. Forwarded to `PowerHistogram`.
 * @property {?(function(number):void)} [onDrift] Called with each drift sample
 *   in milliseconds, for hook-based alerting. A throwing hook is swallowed:
 *   it must not be able to stop the monitor.
 * @property {boolean} [keepProcessAlive=false] Passed through to the internal
 *   timer, which is `unref()`d by default. Set `true` to hold the Node process
 *   open while monitoring.
 * @property {?(function():({active:number, idle:number, utilization:number}))} [utilizationProvider]
 *   Supplies `utilization()` instead of resolving Node's `perf_hooks`. The
 *   argument exists so a browser build, a bundler, or a test can provide the
 *   reading without this module reaching for a Node built-in.
 */

/**
 * The idempotent release callback handed out by the permit-gate family
 * (`PowerPermitGate`, `PowerSemaphore`, `PowerBackpressure`).
 *
 * Named so those helpers can promise a callable. All three previously published
 * `Function` / `Promise<Function>`, and `Function` carries no call signature, so
 * it is not assignable to `() => void` - which made `PowerSemaphore.acquire()`
 * unable to return what its own gate returns, and made the documented
 * `.then((release) => release())` not type-check for a consumer.
 *
 * @typedef {() => void} PowerReleaseFn
 */

/**
 * The rejection `PowerBulkhead.reset()` hands to every queued waiter.
 *
 * `code` is stamped on it (`ERR_BULKHEAD_RESET` unless the caller's reason
 * already carried one) so a caller can tell a bulkhead teardown from a genuine
 * task failure - which `Error` alone cannot.
 *
 * @typedef {Error & {code?: string}} BulkheadResetError
 */

/**
 * Options accepted by `PowerBulkhead.reset()` / `dispose()`.
 *
 * @typedef {Object} PowerBulkheadResetOptions
 * @property {number} [available] Permits to restore per partition. Defaults to
 *   `maxConcurrency`.
 * @property {string|Error} [reason] Rejection reason for queued waiters.
 */

/**
 * Bulkhead construction options.
 * @typedef {Object} PowerBulkheadOptions
 * @property {number} [partitions=4] Number of isolated execution partitions.
 * @property {number} [maxConcurrency=1] Maximum concurrent tasks per partition.
 * @property {number} [queueCapacity=100] Maximum queued tasks across all
 *   partitions.
 * @property {(key:any)=>number} [partitioner] Maps a key to a partition index.
 * @property {(err:any)=>void} [onError] Invoked whenever a user-supplied
 *   `release()` or task hook throws. Added in 2.0; without it those failures were
 *   silently discarded, because the field was read but never assigned.
 */

/**
 * AIMD settings for `PowerBackpressure` (`adaptive`).
 *
 * Disabled by default: the pre-2.0 behaviour, a constant `refillAmount`, is
 * unchanged unless asked for.
 *
 * @typedef {Object} BackpressureAdaptiveOptions
 * @property {boolean} [enabled=true] Set `false` to keep the constants but
 *   leave AIMD off - useful for turning it off without unsetting the tuning.
 * @property {number} [additiveIncrease=1] Permits added per refill tick that
 *   finds consumers draining. TCP adds one segment per round trip; here a tick
 *   is the unit of observation.
 * @property {number} [beta=0.5] Multiplicative decrease factor, clamped to
 *   `(0.1, 0.99)`. 0.5 is TCP's.
 * @property {number} [min=1] Floor for the refill amount. Never probes with
 *   less than one permit, so a backoff cannot deadlock the queue.
 * @property {number} [max=1000000] Ceiling, so a permanently fast consumer
 *   cannot drive the window past capacity on its own. The refill is still
 *   capped by the number of missing permits.
 */

/**
 * Circuit options for `PowerCircuit`.
 * @typedef {Object} PowerCircuitOptions
 * @property {number} [threshold=5] Consecutive failures before the circuit opens.
 * @property {number} [timeout=30000] Milliseconds the circuit stays open before
 *   a trial call is allowed.
 * @property {(state:string,reason?:string)=>void} [onStateChange] - Called as
 *   `(state, reason)` on every transition. `reason` is one of `success`,
 *   `thresholdExceeded`, `timeoutElapsed`, `trialFailed`, `reset` or
 *   `hub-closed`.
 * @property {import("./powerEventBus.js").PowerEventBus} [eventBus] - When
 *   given, transitions are also emitted on it as `stateChange`.
 */

/**
 * The three states a `PowerCircuit` moves between.
 * @typedef {'closed'|'open'|'half-open'} CircuitState
 */

/**
 * The rejection `PowerCircuit.call()` throws while the circuit is open.
 *
 * A named type because the `code` is the documented contract - the guide and
 * `powerCircuit.test.js` both branch on `err.code === 'ECIRCUITOPEN'` - and an
 * `Error` does not carry one.
 *
 * @typedef {Error & {code: 'ECIRCUITOPEN'}} CircuitOpenError
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
 * @property {?(function(*):number)} [weightFn]
 * @property {number} [defaultTTL]
 * @property {number} [maxPoolSize]
 * @property {boolean} [rejectOversized]
 * @property {?(function(*, *, string):void)} [onEvict]
 * @property {?(function(*, *):void)} [onExpire]
 * @property {number} [initialPoolSize]
 * @property {number} [maxCleanupPerTick]
 * @property {boolean} [eagerCleanupOnRead]
 * @property {number} [defaultAsyncTimeout] - Default timeout (ms) applied to
 *   `getOrSetAsync` when a caller omits its own `timeout`.
 * @property {?(function(*, string):void)} [onError] - Invoked as `onError(err, message)`
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
