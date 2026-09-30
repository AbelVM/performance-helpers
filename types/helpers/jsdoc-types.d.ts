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
     */
    maxQueueLength?: number | undefined;
    /**
     * - Opt in to
     * metrics: `true` registers this helper in the shared collector, or pass a
     * collector of your own. Off by default, so the common case allocates nothing.
     * See `guides/metrics.md`.
     * (the default) keeps the pre-2.0 behaviour where `queuePolicy: 'enqueue'`
     * grows without bound. With a finite cap the *incoming* task is the one that
     * is refused, because a cap is what the caller asked for; `drop-oldest` is
     * the exception and still evicts the oldest to make room for the newest.
     * A refused task returns `false`, or rejects with `ERR_POOL_QUEUE_FULL` when
     * the caller is awaiting a response.
     */
    observability?: boolean | import("./metrics.js").MetricsCollector | undefined;
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
     * - Wire
     * protocol for object messages. `'framed'` (default since 2.0) posts a
     * `PowerMessageCodec` envelope; `'legacy'` restores the 1.x bare-JSON framing
     * for a worker that has not migrated yet; `'negotiated'` behaves exactly like
     * `'framed'` until a worker advertises the native structured-clone carrier
     * with `announceCapabilities()`, and sends that carrier to that worker alone.
     * See the migration note in `guides/powerPool.md`.
     */
    messageCodec?: "framed" | "legacy" | "negotiated" | undefined;
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
    /**
     * - Set once this worker's in-flight tasks have been
     * settled in bulk by termination. A `message` already in flight from the worker
     * still reaches the pool handler, and without this the global `_activeTasks`
     * would be decremented a second time - stealing a count that belongs to a
     * *different* worker still doing work, so the pool would report idle while
     * tasks were outstanding. BUG-011.
     */
    tasksSettled: boolean;
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
     * `fn` receives the attempt's `AbortSignal` and it is aborted when the attempt
     * runs long. **A timed-out attempt is retried like any other failure**, so this
     * is a per-attempt bound and the worst case is roughly
     * `attemptTimeout * maxAttempts` plus the delays — measured with
     * `attemptTimeout: 40` and `maxAttempts: 3`, three attempts ran. This used to
     * say the opposite ("a timed-out attempt is **not** retried"), which was false
     * and would have led a caller to read a hard bound into a per-attempt one. For
     * a hard bound on the whole call, use `totalTimeout`.
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
     */
    ratio?: number | undefined;
    /**
     * - Opt in to
     * metrics: `true` registers this helper in the shared collector, or pass a
     * collector of your own. Off by default, so the common case allocates nothing.
     * See `guides/metrics.md`.
     * `(0, 1]`. 0.2 is the top of the 10-20 % band the Google SRE *Handling
     * Overload* chapter recommends. Values above 1 throw: a budget permitting
     * more retries than requests is the amplification it exists to prevent.
     */
    observability?: boolean | import("./metrics.js").MetricsCollector | undefined;
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
     *
     * A limiter constructed with its own `now` ignores any per-call value a
     * composition threads in - see `LimiterNowOptions`.
     */
    refillRate?: number | undefined;
    /**
     * - Clock override in ms. Defaults to the
     * library's `nowMs()`. Injected for tests and for compositions; it outranks
     * any per-call value.
     */
    now?: (() => number) | undefined;
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
     * How the batch is
     * scheduled, passed straight to `PowerScheduler`. The set matches the
     * scheduler's own, including `'yield'` — the native continuation, which the
     * scheduler prioritises. An unrecognised value throws.
     */
    scheduling?: "microtask" | "macrotask" | "yield" | undefined;
    /**
     * Called when the handler rejects with no
     * pending promise to reject, which is a scheduler-driven flush rather than an
     * `add()`-triggered one. Without it that error had nowhere to go.
     */
    onError?: ((err: any) => void) | undefined;
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
    /**
     * Injected clock, as the limiters take (PERF-007).
     * Expiry is the one behaviour in this class that cannot be observed without
     * a clock, so a test that wants to assert "expired after 150 ms" had either
     * to sleep or to be dropped. `new PowerTTLMap({ now: () => clock })` makes
     * the assertion exact.
     */
    now?: (() => number) | undefined;
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
     *
     * A limiter constructed with its own `now` ignores any per-call value a
     * composition threads in - see `LimiterNowOptions`.
     */
    windowMs?: number | undefined;
    /**
     * - Clock override in ms. Defaults to the
     * library's `nowMs()`. Injected for tests and for compositions; it outranks
     * any per-call value.
     */
    now?: (() => number) | undefined;
};
/**
 * Per-call options shared by every limiter's clock-reading methods.
 *
 * The same shape on `tryConsume`, `reserve`, `available` and `retryAfter` so a
 * caller - in practice `PowerRateLimit` - can hand one reading of the clock to a
 * whole composition. `nowMs()` costs ~141 ns because it reads two clocks per
 * call, so an N-limiter composition was spending N of them.
 */
export type LimiterNowOptions = {
    /**
     * - Milliseconds since epoch, used for this call only.
     * **A limiter constructed with its own `now` ignores this**: an explicitly
     * injected clock always wins, so a limiter under test cannot have its notion
     * of time silently replaced by the composer's.
     */
    now?: number | undefined;
};
/**
 * A normalised inbound socket message, identical across all three transport
 * models.
 *
 * This is the whole point of `PowerSocketAdapter`: Node `ws` hands a handler
 * `(data, isBinary)`, a browser `WebSocket` hands it an event object, and a
 * `WebSocketStream` hands it the bare written value. Without normalisation,
 * every consumer needs all three branches.
 */
export type PowerSocketAdapterMessage = {
    /**
     * - The payload, as the transport delivered it.
     */
    data: any;
    /**
     * - `false` only for a text frame. For a
     * `WebSocketStream` this is inferred, since the stream carries no frame type.
     */
    isBinary: boolean;
    /**
     * -
     * The adapter that received it, for `send()` from inside a handler.
     */
    adapter: import("./powerSocketAdapter.js").PowerSocketAdapter;
};
/**
 * Called when an inbound message is refused by `PowerSocketAdapter`'s rate
 * limit, with the running count of refusals.
 *
 * Named rather than inlined because the JSDoc parser mis-associates an inline
 * `{function(count:number): void}` property that follows a multi-line
 * description: it absorbed the following `@property` line into its own
 * parameter list and emitted a property literally named `""`. An inline type
 * that parses wrongly is worse than no type, because it looks present.
 */
export type PowerSocketAdapterRateLimited = (count: number) => void;
/**
 * Options for `PowerSocketAdapter`.
 */
export type PowerSocketAdapterOptions = {
    /**
     * - Transport family. Detected
     * from the socket's capabilities when omitted; pass it to override detection,
     * or when adapting a socket the detector cannot recognise. An unrecognised
     * value throws rather than being stored — a stored kind that matched no
     * branch would attach nothing and report itself open.
     */
    kind?: "ws" | "websocket" | "stream" | undefined;
    /**
     * - Opt in to
     * metrics: `true` registers this helper in the shared collector, or pass a
     * collector of your own. Off by default, so the common case allocates nothing.
     * See `guides/metrics.md`.
     * from the socket's capabilities by default; pass it only to override a
     * misdetection.
     */
    observability?: boolean | import("./metrics.js").MetricsCollector | undefined;
    /**
     * -
     * Called for each accepted inbound message. A returned promise is awaited
     * for {@link PowerSocketAdapter#drain}, and a rejection is routed to
     * `onError`.
     */
    onMessage?: ((arg0: PowerSocketAdapterMessage) => (void | Promise<void>)) | undefined;
    /**
     * - Socket opened.
     */
    onOpen?: ((arg0: import("./powerSocketAdapter.js").PowerSocketAdapter) => void) | undefined;
    /**
     * - Socket closed, for any reason including a heartbeat or idle timeout.
     */
    onClose?: ((arg0: {
        code: number;
        reason: string;
        adapter: import("./powerSocketAdapter.js").PowerSocketAdapter;
    }) => void) | undefined;
    /**
     * - A transport, handler, or send error. A throwing `onError` is swallowed.
     */
    onError?: ((arg0: any, arg1: import("./powerSocketAdapter.js").PowerSocketAdapter) => void) | undefined;
    /**
     * - An inbound message was refused by the rate limit. Called with the running count of refusals.
     */
    onRateLimited?: PowerSocketAdapterRateLimited | undefined;
    /**
     * - Send a ping at this interval. `0` disables. Requires a transport that exposes `ping()` (Node `ws`); on others the adapter reports `canPing === false` and does not pretend to be heartbeating.
     */
    heartbeatIntervalMs?: number | undefined;
    /**
     * - Declare the socket dead if no
     * pong or message arrives in this long. `0` disables.
     */
    heartbeatTimeoutMs?: number | undefined;
    /**
     * - Declare the socket dead if nothing at
     * all arrives for this long. `0` disables. This is the liveness signal
     * available on transports with no `ping()`.
     */
    idleTimeoutMs?: number | undefined;
    /**
     * - Per-socket inbound
     * rate limit. Omitted means no limit.
     */
    rateLimit?: {
        limit: number;
        windowMs: number;
    } | undefined;
    /**
     * - What to do with a
     * rate-limited message. `close` uses code 1008 (policy violation).
     */
    rateLimitAction?: "close" | "drop" | undefined;
    /**
     * - How long `drain()` waits for
     * in-flight handlers before closing anyway. `0` waits indefinitely.
     */
    drainTimeoutMs?: number | undefined;
};
/**
 * Logger options for `PowerLogger`.
 */
export type PowerLoggerOptions = {
    format?: "json" | "text" | undefined;
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
     */
    intervalMs?: number | undefined;
    /**
     * - Opt in to
     * metrics: `true` registers this helper in the shared collector, or pass a
     * collector of your own. Off by default, so the common case allocates nothing.
     * See `guides/metrics.md`.
     * Smaller catches shorter blocks and costs more; the drift is recorded per
     * probe, so 20ms means "worst block seen between two probes 20ms apart".
     */
    observability?: boolean | import("./metrics.js").MetricsCollector | undefined;
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
     */
    queueCapacity?: number | undefined;
    /**
     * - Opt in to
     * metrics: `true` registers this helper in the shared collector, or pass a
     * collector of your own. Off by default, so the common case allocates nothing.
     * See `guides/metrics.md`.
     * partitions.
     */
    observability?: boolean | import("./metrics.js").MetricsCollector | undefined;
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
    /**
     * - Whether this node sits in the W-TinyLFU
     * admission window. Off unless `windowSize` is set, and read only by the
     * window path. Declared here rather than left to the object literal in
     * `_allocNode`, because a property the typedef does not mention is a property
     * every other reference to a node has to be narrowed around.
     */
    inWindow: boolean;
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
    /**
     * - Default timeout (ms) applied to
     */
    defaultAsyncTimeout?: number | undefined;
    /**
     * Injected clock in milliseconds, matching the limiters
     * (PERF-007) and `PowerTTLMap`. Expiry is the one behaviour here that cannot be
     * observed synchronously, so this is what turns "assert it expired after 100 ms"
     * from a sleep into an exact assertion. See `guides/powerCache.md`.
     * `getOrSetAsync` when a caller omits its own `timeout`.
     */
    now?: (() => number) | undefined;
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
     * - Size of the W-TinyLFU admission
     * window, used only with `admission: 'tinylfu'`. `0` (the default) is the
     * shipped behaviour, which refuses a challenger outright rather than routing it
     * through a window. A positive value makes the last `windowSize` entries the
     * window: new keys land there unconditionally and only the window's oldest is
     * arbitrated against the main-space victim. `null` selects the recommended
     * size, `min(max(4, ceil(maxEntries * 0.01)), floor(maxEntries / 4))`.
     * See `adr/0003-tinylfu-admission-window.md`.
     */
    windowSize?: number | null | undefined;
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
/**
 * Permit-gate options, for `PowerPermitGate` and everything built on it.
 *
 * A named type rather than `@param {Object}` plus a stack of `options.*` lines,
 * which is what the constructor published before: the emitted declaration
 * carried a bare `Object`, so nothing a caller passed was checked.
 */
export type PowerPermitGateOptions = {
    /**
     * Permits held. `0` throws rather than being
     * read as "unset" - a gate configured to allow nothing is how a dependency
     * gets switched off, and silently becoming open is the worst direction for
     * it to fail in.
     */
    capacity?: number | undefined;
    /**
     * Waiters allowed to block. `0`
     * refuses immediately instead of queueing. `Infinity` means unbounded.
     */
    queueCapacity?: number | undefined;
    /**
     * Permits available at
     * construction. `0` is legal and meaningful - "start with nothing and let it
     * refill" is the point of a token bucket - and is clamped to `capacity`.
     */
    initialTokens?: number | undefined;
};
/**
 * Backpressure options for `PowerBackpressure`, which extends the permit gate
 * with a refill schedule.
 *
 * `capacity` and `queueCapacity` come from {@link PowerPermitGateOptions} but
 * default differently here (100 and 1000, not 1 and `Infinity`), so both are
 * redeclared rather than inherited: an intersection would publish the wrong
 * default in the one place a caller reads them.
 */
export type PowerBackpressureOptions = {
    /**
     * Maximum number of concurrent permits.
     */
    capacity?: number | undefined;
    /**
     * Maximum number of waiting producers.
     * `Infinity` queues without bound.
     */
    queueCapacity?: number | undefined;
    /**
     * Initial available permits. `0` is
     * legal and means "nothing may run until the first refill".
     */
    initialTokens?: number | undefined;
    /**
     * Available-permit level below which adaptive
     * refill begins. Defaults to `25 %` of `capacity`.
     */
    lowWaterMark?: number | undefined;
    /**
     * Permits added per refill tick while under
     * pressure. Defaults to `10 %` of `capacity`, at least 1.
     */
    refillAmount?: number | undefined;
    /**
     * Milliseconds between refill ticks.
     */
    refillInterval?: number | undefined;
    /**
     * AIMD
     * tuning of `refillAmount`. Off by default, so the constant-behaviour path is
     * unchanged unless asked for.
     */
    adaptive?: boolean | BackpressureAdaptiveOptions | undefined;
};
/**
 * Options for `PowerHistogram`.
 */
export type PowerHistogramOptions = {
    /**
     * Target relative error for every
     * quantile, in `(0, 1)`. Smaller is more accurate and uses more buckets;
     * outside the range throws.
     */
    relativeAccuracy?: number | undefined;
    /**
     * Advisory upper bound. Values above it are
     * still stored faithfully, and are only counted in `outOfRangeCount`.
     */
    maxValue?: number | undefined;
    /**
     * Advisory lower bound, counted in
     * `belowRangeCount`.
     */
    minValue?: number | undefined;
    /**
     * Legacy option, retained so existing calls
     * keep working. It no longer sizes a dense array - read the `bucketCount`
     * getter for the number of *occupied* buckets.
     */
    bucketCount?: number | undefined;
};
/**
 * Options for `PowerScheduler`.
 */
export type PowerSchedulerOptions = {
    /**
     * How the flush is
     * scheduled. `'yield'` is the cooperative primitive added in 2.0. An
     * unrecognised value throws rather than falling back to the fastest strategy.
     */
    scheduling?: "microtask" | "macrotask" | "yield" | undefined;
    /**
     * Called when a flush throws. A
     * throwing `onError` is swallowed.
     */
    onError?: ((error: unknown) => void) | null | undefined;
};
/**
 * Subscriber-set options for `PowerSubscriberSet`.
 *
 * Distinct from {@link PowerEventBusOptions}, which it does not extend, because
 * the set has no `event` dimension: `maxListeners` caps the whole set rather
 * than one event's bucket.
 */
export type PowerSubscriberSetOptions = {
    /**
     * Store listeners behind `WeakRef`, so a
     * listener no longer referenced elsewhere can be collected.
     */
    weak?: boolean | undefined;
    /**
     * Cap on the set. `0` (the default) is
     * unlimited. A negative throws: clamped to `0` it would have silently
     * *removed* the cap, which is the one failure direction a leak guard must not
     * have.
     */
    maxListeners?: number | undefined;
};
/**
 * Options for `PowerMemoizer`.
 */
export type PowerMemoizerOptions = {
    /**
     * Maps the wrapped call's
     * arguments to a cache key. Defaults to `JSON.stringify` on the arguments.
     * Convenient, but expensive for large or deeply-nested ones; on a hot path
     * prefer something cheap and deterministic (join scalar arguments with a
     * separator, or hash).
     */
    keyResolver?: ((...arg0: any[]) => string) | undefined;
    /**
     * Forwarded to the underlying
     * `PowerCache`.
     */
    cacheOptions?: PowerCacheOptions | undefined;
    /**
     * Default TTL (ms) for wrappers built by this
     * memoizer.
     */
    ttl?: number | undefined;
    /**
     * Default weight for wrappers built by this
     * memoizer.
     */
    weight?: number | undefined;
};
/**
 * Options for `PowerTimedCache`, a `PowerCache` with a fixed TTL and an
 * automatic cleanup interval.
 */
export type PowerTimedCacheOptions = {
    /**
     * Forwarded to `PowerCache`; takes precedence
     * over the same key in `cacheOptions`.
     */
    maxEntries?: number | undefined;
    /**
     * Cleanup interval (ms). Omitted, cleanup is
     * started with `PowerCache`'s own default.
     */
    interval?: number | undefined;
    /**
     * Nodes scanned per cleanup tick.
     */
    maxCleanupPerTick?: number | undefined;
    /**
     * Additional options forwarded to
     * `PowerCache`.
     */
    cacheOptions?: PowerCacheOptions | undefined;
};
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
 */
export type WorkerAgnosticOptions = {
    [x: string]: any;
};
/**
 * Options for `PowerRateLimit`.
 */
export type PowerRateLimitOptions = {
    /**
     * Attempt all-or-nothing semantics across the
     * composed limiters. Requires each to expose `available()` or an undo
     * primitive (`reserve`/`release`, or `addTokens`); when a safe rollback cannot
     * be guaranteed the call returns `false`.
     *
     * Per-call `tryConsume(n, options)` also accepts a `{ now }` number - read
     * **once per composed call** and threaded into every leg (PERF-007). There is
     * deliberately no constructor `now` here: on the limiters `now` is a *function*,
     * and having one name mean a function in one place and a number in another on
     * the same class is a trap. The composer needs no injected clock of its own,
     * because the per-call value covers every use the limiters' injection does.
     */
    atomic?: boolean | undefined;
};
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
 */
export type RateLimiterLike = {
    /**
     * -
     * The optional second argument carries a single `now` for the whole
     * composition (PERF-007). A limiter that did not inject its own clock
     * should honour it; one that did must ignore it, or a limiter under test
     * silently changes clock mid-run. A limiter that takes only `n` is fine -
     * it simply reads its own clock.
     */
    tryConsume: (arg0: number | undefined, arg1: LimiterNowOptions | undefined) => (boolean | {
        ok: boolean;
        retryAfterMs?: number;
    });
    /**
     * A token to pass to `release` when it reserves a slot, `false` when it
     * cannot, `null` when it has no reservation concept. `PowerGCRA` returns a
     * number; `PowerThrottle` returns `{ n }`.
     */
    reserve?: ((arg0?: number | undefined) => {
        n: number;
    } | number | boolean | null) | undefined;
    release?: ((arg0: any) => void) | undefined;
    addTokens?: ((arg0: number) => void) | undefined;
    rollback?: ((arg0: number) => void) | undefined;
    /**
     * A count, or a method that
     * returns one. Both `PowerGCRA` and `PowerThrottle` expose `available()` as
     * a *method* - the first draft of this typedef said `number`, and the
     * consumer type test caught it by refusing to accept either helper as a
     * limiter.
     */
    available?: number | ((arg0?: LimiterNowOptions | undefined) => number) | undefined;
    /**
     * Clear the limiter's state, when it has a
     * reset at all. Called by `PowerRateLimit.reset()`.
     */
    reset?: (() => void) | undefined;
};
