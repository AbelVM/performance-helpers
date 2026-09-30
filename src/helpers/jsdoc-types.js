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
 * @property {number} [maxQueueLength] - Hard cap on queued tasks. `Infinity`
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] - Opt in to
 *   metrics: `true` registers this helper in the shared collector, or pass a
 *   collector of your own. Off by default, so the common case allocates nothing.
 *   See `guides/metrics.md`.
 *   (the default) keeps the pre-2.0 behaviour where `queuePolicy: 'enqueue'`
 *   grows without bound. With a finite cap the *incoming* task is the one that
 *   is refused, because a cap is what the caller asked for; `drop-oldest` is
 *   the exception and still evicts the oldest to make room for the newest.
 *   A refused task returns `false`, or rejects with `ERR_POOL_QUEUE_FULL` when
 *   the caller is awaiting a response.
 * @property {number} [maxDrainWaiters] - Cap on concurrent `drain()` waits.
 *   Beyond it, `drain()` rejects with `ERR_POOL_DRAIN_TOO_MANY_WAITERS`
 *   instead of accumulating an unbounded number of `idle` listeners.
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
 * @property {'framed'|'legacy'|'negotiated'} [messageCodec='framed'] - Wire
 *   protocol for object messages. `'framed'` (default since 2.0) posts a
 *   `PowerMessageCodec` envelope; `'legacy'` restores the 1.x bare-JSON framing
 *   for a worker that has not migrated yet; `'negotiated'` behaves exactly like
 *   `'framed'` until a worker advertises the native structured-clone carrier
 *   with `announceCapabilities()`, and sends that carrier to that worker alone.
 *   See the migration note in `guides/powerPool.md`.
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
 * @property {boolean} tasksSettled - Set once this worker's in-flight tasks have been
 *   settled in bulk by termination. A `message` already in flight from the worker
 *   still reaches the pool handler, and without this the global `_activeTasks`
 *   would be decremented a second time - stealing a count that belongs to a
 *   *different* worker still doing work, so the pool would report idle while
 *   tasks were outstanding. BUG-011.
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
 * @property {number} [maxAttempts=3] - Total attempts, including the first.
 *   Must be `>= 1`; a `0` or negative value throws rather than resolving to 1.
 * @property {'exponential'|'linear'|'fixed'|'decorrelated'} [backoff='exponential'] -
 *   The delay curve. `decorrelated` is the AWS random-walk form, where each
 *   delay is drawn against the *previous* delay rather than a formula. An
 *   unrecognised value throws.
 * @property {number} [baseDelay=100]
 * @property {number} [maxDelay=10000]
 * @property {boolean} [jitter=true] - Randomise within `[0.5 * delay, delay]`.
 *   Rejected at `false` when `backoff` is `decorrelated`, which is defined as
 *   randomised.
 * @property {(err:any)=>boolean} [retryIf]
 * @property {(attempt:number, err:any, delay:number)=>void} [onRetry]
 * @property {number} [attemptTimeout] - Per-attempt timeout in ms. When set,
 *   `fn` receives the attempt's `AbortSignal`, and a timed-out attempt is
 *   **not** retried: the caller asked for that bound, and retrying would
 *   multiply it by `maxAttempts`.
 * @property {import('./powerRetry.js').PowerRetryBudget|number} [budget] - A
 *   retry budget. A `PowerRetryBudget` bounds retry traffic across calls; a
 *   number is a ratio, which builds a bucket scoped to this call only. `0.2`
 *   permits retries up to 20 % of request volume.
 * @property {number} [hedgeDelay=0] - Milliseconds to wait on the **first**
 *   attempt before sending a duplicate. The first to succeed wins and the
 *   loser is aborted. `0` disables hedging. Only a hedge draws the budget a
 *   token; a refused budget means no hedge rather than a failed attempt.
 */

/**
 * Options for `PowerRetryBudget`.
 *
 * @typedef {Object} PowerRetryBudgetOptions
 * @property {number} [ratio=0.2] - Retry tokens granted per request, in
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] - Opt in to
 *   metrics: `true` registers this helper in the shared collector, or pass a
 *   collector of your own. Off by default, so the common case allocates nothing.
 *   See `guides/metrics.md`.
 *   `(0, 1]`. 0.2 is the top of the 10-20 % band the Google SRE *Handling
 *   Overload* chapter recommends. Values above 1 throw: a budget permitting
 *   more retries than requests is the amplification it exists to prevent.
 * @property {number} [capacity=10] - Ceiling on stored tokens, which is the
 *   burst allowance. A capacity of 1 would refuse the first retry of a fresh
 *   budget, engaging the protection on a healthy dependency.
 */

/**
 * A snapshot of a `PowerRetryBudget`.
 *
 * @typedef {Object} PowerRetryBudgetStats
 * @property {number} ratio
 * @property {number} capacity
 * @property {number} available - Retry tokens left right now.
 * @property {number} requests - Requests recorded via `recordRequest()`.
 * @property {number} retries - Tokens actually spent on retries and hedges.
 * @property {number} refused - Retries and hedges the budget denied.
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
 *
 * A limiter constructed with its own `now` ignores any per-call value a
 * composition threads in - see `LimiterNowOptions`.
 * @property {function(): number} [now] - Clock override in ms. Defaults to the
 *   library's `nowMs()`. Injected for tests and for compositions; it outranks
 *   any per-call value.
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
 * @property {() => number} [now] Injected clock, as the limiters take (PERF-007).
 *   Expiry is the one behaviour in this class that cannot be observed without
 *   a clock, so a test that wants to assert "expired after 150 ms" had either
 *   to sleep or to be dropped. `new PowerTTLMap({ now: () => clock })` makes
 *   the assertion exact.
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
 *
 * A limiter constructed with its own `now` ignores any per-call value a
 * composition threads in - see `LimiterNowOptions`.
 * @property {function(): number} [now] - Clock override in ms. Defaults to the
 *   library's `nowMs()`. Injected for tests and for compositions; it outranks
 *   any per-call value.
 */

/**
 * Per-call options shared by every limiter's clock-reading methods.
 *
 * The same shape on `tryConsume`, `reserve`, `available` and `retryAfter` so a
 * caller - in practice `PowerRateLimit` - can hand one reading of the clock to a
 * whole composition. `nowMs()` costs ~141 ns because it reads two clocks per
 * call, so an N-limiter composition was spending N of them.
 *
 * @typedef {Object} LimiterNowOptions
 * @property {number} [now] - Milliseconds since epoch, used for this call only.
 *   **A limiter constructed with its own `now` ignores this**: an explicitly
 *   injected clock always wins, so a limiter under test cannot have its notion
 *   of time silently replaced by the composer's.
 */

/**
 * A normalised inbound socket message, identical across all three transport
 * models.
 *
 * This is the whole point of `PowerSocketAdapter`: Node `ws` hands a handler
 * `(data, isBinary)`, a browser `WebSocket` hands it an event object, and a
 * `WebSocketStream` hands it the bare written value. Without normalisation,
 * every consumer needs all three branches.
 *
 * @typedef {Object} PowerSocketAdapterMessage
 * @property {any} data - The payload, as the transport delivered it.
 * @property {boolean} isBinary - `false` only for a text frame. For a
 *   `WebSocketStream` this is inferred, since the stream carries no frame type.
 * @property {import('./powerSocketAdapter.js').PowerSocketAdapter} adapter -
 *   The adapter that received it, for `send()` from inside a handler.
 */

/**
 * Called when an inbound message is refused by `PowerSocketAdapter`'s rate
 * limit, with the running count of refusals.
 *
 * Named rather than inlined because the JSDoc parser mis-associates an inline
 * `{function(count:number): void}` property that follows a multi-line
 * description: it absorbed the following `@property` line into its own
 * parameter list and emitted a property literally named `""`. An inline type
 * that parses wrongly is worse than no type, because it looks present.
 *
 * @typedef {(count:number) => void} PowerSocketAdapterRateLimited
 */

/**
 * Options for `PowerSocketAdapter`.
 *
 * @typedef {Object} PowerSocketAdapterOptions
 * @property {'ws'|'websocket'|'stream'} [kind] - Transport family. Detected
 *   from the socket's capabilities when omitted; pass it to override detection,
 *   or when adapting a socket the detector cannot recognise. An unrecognised
 *   value throws rather than being stored — a stored kind that matched no
 *   branch would attach nothing and report itself open.
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] - Opt in to
 *   metrics: `true` registers this helper in the shared collector, or pass a
 *   collector of your own. Off by default, so the common case allocates nothing.
 *   See `guides/metrics.md`.
 *   from the socket's capabilities by default; pass it only to override a
 *   misdetection.
 * @property {function(PowerSocketAdapterMessage): (void|Promise<void>)} [onMessage] -
 *   Called for each accepted inbound message. A returned promise is awaited
 *   for {@link PowerSocketAdapter#drain}, and a rejection is routed to
 *   `onError`.
 * @property {function(import('./powerSocketAdapter.js').PowerSocketAdapter): void} [onOpen] - Socket opened.
 * @property {function({code:number, reason:string, adapter:import('./powerSocketAdapter.js').PowerSocketAdapter}): void} [onClose] - Socket closed, for any reason including a heartbeat or idle timeout.
 * @property {function(any, import('./powerSocketAdapter.js').PowerSocketAdapter): void} [onError] - A transport, handler, or send error. A throwing `onError` is swallowed.
 * @property {PowerSocketAdapterRateLimited} [onRateLimited] - An inbound message was refused by the rate limit. Called with the running count of refusals.
 * @property {number} [heartbeatIntervalMs=30000] - Send a ping at this interval. `0` disables. Requires a transport that exposes `ping()` (Node `ws`); on others the adapter reports `canPing === false` and does not pretend to be heartbeating.
 * @property {number} [heartbeatTimeoutMs=10000] - Declare the socket dead if no
 *   pong or message arrives in this long. `0` disables.
 * @property {number} [idleTimeoutMs=0] - Declare the socket dead if nothing at
 *   all arrives for this long. `0` disables. This is the liveness signal
 *   available on transports with no `ping()`.
 * @property {{limit:number, windowMs:number}} [rateLimit] - Per-socket inbound
 *   rate limit. Omitted means no limit.
 * @property {'drop'|'close'} [rateLimitAction='drop'] - What to do with a
 *   rate-limited message. `close` uses code 1008 (policy violation).
 * @property {number} [drainTimeoutMs=5000] - How long `drain()` waits for
 *   in-flight handlers before closing anyway. `0` waits indefinitely.
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
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] - Opt in to
 *   metrics: `true` registers this helper in the shared collector, or pass a
 *   collector of your own. Off by default, so the common case allocates nothing.
 *   See `guides/metrics.md`.
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
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] - Opt in to
 *   metrics: `true` registers this helper in the shared collector, or pass a
 *   collector of your own. Off by default, so the common case allocates nothing.
 *   See `guides/metrics.md`.
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
 * @property {number} [timeout=30000] **Base** milliseconds the circuit stays
 *   open before a trial call is allowed. Consecutive trips grow this
 *   exponentially and jitter the result, so a fleet of clients does not probe
 *   one dependency in lockstep; the first trip uses this value unchanged.
 * @property {number} [maxTimeout] Ceiling for the grown open window. Defaults
 *   to `timeout * 16`.
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
 * @property {boolean} inWindow - Whether this node sits in the W-TinyLFU
 *   admission window. Off unless `windowSize` is set, and read only by the
 *   window path. Declared here rather than left to the object literal in
 *   `_allocNode`, because a property the typedef does not mention is a property
 *   every other reference to a node has to be narrowed around.
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
 * @property {() => number} [now] Injected clock in milliseconds, matching the limiters
 *   (PERF-007) and `PowerTTLMap`. Expiry is the one behaviour here that cannot be
 *   observed synchronously, so this is what turns "assert it expired after 100 ms"
 *   from a sleep into an exact assertion. See `guides/powerCache.md`.
 *   `getOrSetAsync` when a caller omits its own `timeout`.
 * @property {?(function(*, string):void)} [onError] - Invoked as `onError(err, message)`
 *   whenever an internal failure is swallowed: a throwing `onEvict`/`onExpire`
 *   callback, or a failing `weightFn`.
 * @property {'none'|'tinylfu'} [admission='none'] - Admission filter in front
 *   of the eviction policy. `'tinylfu'` runs a 4-bit Count-Min frequency
 *   sketch and refuses an insert when the entry it would evict is still wanted,
 *   which is what makes a cache survive a one-off scan. Only consulted at
 *   capacity, and a tie keeps the incumbent.
 * @property {number|null} [windowSize=0] - Size of the W-TinyLFU admission
 *   window, used only with `admission: 'tinylfu'`. `0` (the default) is the
 *   shipped behaviour, which refuses a challenger outright rather than routing it
 *   through a window. A positive value makes the last `windowSize` entries the
 *   window: new keys land there unconditionally and only the window's oldest is
 *   arbitrated against the main-space victim. `null` selects the recommended
 *   size, `min(max(4, ceil(maxEntries * 0.01)), floor(maxEntries / 4))`.
 *   See `adr/0003-tinylfu-admission-window.md`.
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

/**
 * Permit-gate options, for `PowerPermitGate` and everything built on it.
 *
 * A named type rather than `@param {Object}` plus a stack of `options.*` lines,
 * which is what the constructor published before: the emitted declaration
 * carried a bare `Object`, so nothing a caller passed was checked.
 *
 * @typedef {Object} PowerPermitGateOptions
 * @property {number} [capacity=1] Permits held. `0` throws rather than being
 *   read as "unset" - a gate configured to allow nothing is how a dependency
 *   gets switched off, and silently becoming open is the worst direction for
 *   it to fail in.
 * @property {number} [queueCapacity=Infinity] Waiters allowed to block. `0`
 *   refuses immediately instead of queueing. `Infinity` means unbounded.
 * @property {number} [initialTokens=capacity] Permits available at
 *   construction. `0` is legal and meaningful - "start with nothing and let it
 *   refill" is the point of a token bucket - and is clamped to `capacity`.
 */

/**
 * Backpressure options for `PowerBackpressure`, which extends the permit gate
 * with a refill schedule.
 *
 * `capacity` and `queueCapacity` come from {@link PowerPermitGateOptions} but
 * default differently here (100 and 1000, not 1 and `Infinity`), so both are
 * redeclared rather than inherited: an intersection would publish the wrong
 * default in the one place a caller reads them.
 *
 * @typedef {Object} PowerBackpressureOptions
 * @property {number} [capacity=100] Maximum number of concurrent permits.
 * @property {number} [queueCapacity=1000] Maximum number of waiting producers.
 *   `Infinity` queues without bound.
 * @property {number} [initialTokens=capacity] Initial available permits. `0` is
 *   legal and means "nothing may run until the first refill".
 * @property {number} [lowWaterMark] Available-permit level below which adaptive
 *   refill begins. Defaults to `25 %` of `capacity`.
 * @property {number} [refillAmount] Permits added per refill tick while under
 *   pressure. Defaults to `10 %` of `capacity`, at least 1.
 * @property {number} [refillInterval=200] Milliseconds between refill ticks.
 * @property {boolean|BackpressureAdaptiveOptions} [adaptive=false] AIMD
 *   tuning of `refillAmount`. Off by default, so the constant-behaviour path is
 *   unchanged unless asked for.
 */

/**
 * Options for `PowerHistogram`.
 *
 * @typedef {Object} PowerHistogramOptions
 * @property {number} [relativeAccuracy=0.01] Target relative error for every
 *   quantile, in `(0, 1)`. Smaller is more accurate and uses more buckets;
 *   outside the range throws.
 * @property {number} [maxValue=10000] Advisory upper bound. Values above it are
 *   still stored faithfully, and are only counted in `outOfRangeCount`.
 * @property {number} [minValue=0] Advisory lower bound, counted in
 *   `belowRangeCount`.
 * @property {number} [bucketCount] Legacy option, retained so existing calls
 *   keep working. It no longer sizes a dense array - read the `bucketCount`
 *   getter for the number of *occupied* buckets.
 */

/**
 * Options for `PowerScheduler`.
 *
 * @typedef {Object} PowerSchedulerOptions
 * @property {'microtask'|'macrotask'|'yield'} [scheduling] How the flush is
 *   scheduled. `'yield'` is the cooperative primitive added in 2.0. An
 *   unrecognised value throws rather than falling back to the fastest strategy.
 * @property {?((error:unknown)=>void)} [onError] Called when a flush throws. A
 *   throwing `onError` is swallowed.
 */

/**
 * Subscriber-set options for `PowerSubscriberSet`.
 *
 * Distinct from {@link PowerEventBusOptions}, which it does not extend, because
 * the set has no `event` dimension: `maxListeners` caps the whole set rather
 * than one event's bucket.
 *
 * @typedef {Object} PowerSubscriberSetOptions
 * @property {boolean} [weak=false] Store listeners behind `WeakRef`, so a
 *   listener no longer referenced elsewhere can be collected.
 * @property {number} [maxListeners=0] Cap on the set. `0` (the default) is
 *   unlimited. A negative throws: clamped to `0` it would have silently
 *   *removed* the cap, which is the one failure direction a leak guard must not
 *   have.
 */

/**
 * Options for `PowerMemoizer`.
 *
 * @typedef {Object} PowerMemoizerOptions
 * @property {function(...*):string} [keyResolver] Maps the wrapped call's
 *   arguments to a cache key. Defaults to `JSON.stringify` on the arguments.
 *   Convenient, but expensive for large or deeply-nested ones; on a hot path
 *   prefer something cheap and deterministic (join scalar arguments with a
 *   separator, or hash).
 * @property {PowerCacheOptions} [cacheOptions] Forwarded to the underlying
 *   `PowerCache`.
 * @property {number} [ttl] Default TTL (ms) for wrappers built by this
 *   memoizer.
 * @property {number} [weight] Default weight for wrappers built by this
 *   memoizer.
 */

/**
 * Options for `PowerTimedCache`, a `PowerCache` with a fixed TTL and an
 * automatic cleanup interval.
 *
 * @typedef {Object} PowerTimedCacheOptions
 * @property {number} [maxEntries] Forwarded to `PowerCache`; takes precedence
 *   over the same key in `cacheOptions`.
 * @property {number} [interval] Cleanup interval (ms). Omitted, cleanup is
 *   started with `PowerCache`'s own default.
 * @property {number} [maxCleanupPerTick] Nodes scanned per cleanup tick.
 * @property {PowerCacheOptions} [cacheOptions] Additional options forwarded to
 *   `PowerCache`.
 */

/**
 * Options handed straight to the native `Worker` constructor by
 * `WorkerAgnostic`.
 *
 * Typed as an open bag rather than a closed set of keys because that is what it
 * is: the wrapper forwards whatever it is given to whichever constructor the
 * environment supplies, so the keys are Node's `WorkerOptions` on one side and
 * the browser's `WorkerOptions` on the other. The two below are the ones that
 * actually change behaviour here and are named for discoverability; the index
 * signature is what stops the type from rejecting the rest.
 *
 * @property {string} [baseUrl] - The URL a *string* worker source is resolved
 *   against, in a **browser** with a path rather than inline code.
 *
 *   Needed in a `<script type="module">`, and only there. `document.currentScript`
 *   is `null` in a module script per the HTML spec, and the module's own URL is
 *   unreachable from inside a `new Function` -- that evaluates in global scope,
 *   where `import.meta` is a syntax error. So the only base left to fall back on
 *   is `location.href`, which is the **page**, not the module: a worker path
 *   written relative to the module resolves against the page and 404s, and the
 *   error arrives asynchronously on the worker, where it reads as a typo.
 *   Unnecessary for a classic script or an absolute worker source.
 *
 * @typedef {Object.<string, *>} WorkerAgnosticOptions
 */

/**
 * Options for `PowerRateLimit`.
 *
 * @typedef {Object} PowerRateLimitOptions
 * @property {boolean} [atomic=false] Attempt all-or-nothing semantics across the
 *   composed limiters. Requires each to expose `available()` or an undo
 *   primitive (`reserve`/`release`, or `addTokens`); when a safe rollback cannot
 *   be guaranteed the call returns `false`.
 *
 * Per-call `tryConsume(n, options)` also accepts a `{ now }` number - read
 * **once per composed call** and threaded into every leg (PERF-007). There is
 * deliberately no constructor `now` here: on the limiters `now` is a *function*,
 * and having one name mean a function in one place and a number in another on
 * the same class is a trap. The composer needs no injected clock of its own,
 * because the per-call value covers every use the limiters' injection does.
 */

/**
 * The slice of a limiter's surface that `PowerRateLimit` composes.
 *
 * Declared as an interface rather than `Object` because the composer's whole
 * job is calling these members; typing the array as `Object[]` made every one of
 * those calls an error and, worse, meant a limiter that only had `tryConsume`
 * would still be accepted.
 *
 * It also has to be **exported** to reach the published declaration. A local
 * typedef is inlined structurally by the emitter, and the inlined form is
 * unusable: it is a dozen optional members, each with a comment body, repeated
 * for the constructor parameter and for the `limiters` property.
 *
 * @typedef {Object} RateLimiterLike
 * @property {function(number=, LimiterNowOptions=): (boolean|{ok: boolean, retryAfterMs?: number})} tryConsume -
 *   The optional second argument carries a single `now` for the whole
 *   composition (PERF-007). A limiter that did not inject its own clock
 *   should honour it; one that did must ignore it, or a limiter under test
 *   silently changes clock mid-run. A limiter that takes only `n` is fine -
 *   it simply reads its own clock.
 * @property {function(number=): {n: number}|number|boolean|null} [reserve]
 *   A token to pass to `release` when it reserves a slot, `false` when it
 *   cannot, `null` when it has no reservation concept. `PowerGCRA` returns a
 *   number; `PowerThrottle` returns `{ n }`.
 * @property {function(*):void} [release]
 * @property {function(number):void} [addTokens]
 * @property {function(number):void} [rollback]
 * @property {number|function(LimiterNowOptions=): number} [available] A count, or a method that
 *   returns one. Both `PowerGCRA` and `PowerThrottle` expose `available()` as
 *   a *method* - the first draft of this typedef said `number`, and the
 *   consumer type test caught it by refusing to accept either helper as a
 *   limiter.
 * @property {function():void} [reset] Clear the limiter's state, when it has a
 *   reset at all. Called by `PowerRateLimit.reset()`.
 */
