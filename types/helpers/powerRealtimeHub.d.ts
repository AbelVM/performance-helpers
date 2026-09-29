export class PowerRealtimeHub {
    /**
     * @param {HubOptions} options - `send` is required; the constructor throws
     *   without it, so the parameter is not defaulted.
     */
    constructor(options: HubOptions);
    _send: (arg0: object, arg1: Uint8Array) => (void | Promise<void>);
    _close: ((arg0: object, arg1: string) => (void | Promise<void>)) | null;
    _batch: boolean;
    _batchDelayMs: number;
    _codec: "json" | "raw";
    _onError: ((arg0: Error, arg1: object) => void) | null;
    _now: () => number;
    /** @type {Map<string, Map<string, HubSubscriber>>} topic -> subscriberId -> sub */
    _topics: Map<string, Map<string, HubSubscriber>>;
    /** @type {Map<string, HubSubscriber>} subscriberId -> sub */
    _subs: Map<string, HubSubscriber>;
    /** @type {Map<string, any[]>} topic -> retained messages (bounded) */
    _retained: Map<string, any[]>;
    _flushScheduled: boolean;
    _flushTimer: any;
    _closed: boolean;
    _counters: {
        published: number;
        delivered: number;
        dropped: number;
        disconnected: number;
        bytesOut: number;
    };
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
    /**
     * Subscribe to a topic.
     *
     * @param {string} topic - Topic name.
     * @param {function(any, object):void} handler - Invoked with each delivered
     *   message. Throwing is isolated and reported through `onError`.
     * @param {SubscriberOptions} [options]
     * @returns {function():boolean} An unsubscribe function. Returns `false` if
     *   the subscription was already gone.
     */
    subscribe(topic: string, handler: (arg0: any, arg1: object) => void, options?: SubscriberOptions): () => boolean;
    /**
     * Remove a subscription.
     * @param {string} id - Subscriber id.
     * @returns {boolean} `true` when a subscription was removed.
     */
    unsubscribe(id: string): boolean;
    /**
     * Publish a message to every subscriber of a topic.
     *
     * Delivery is asynchronous: the message is queued per subscriber and handed to
     * the transport on the next flush. A `send` adapter that throws is reported
     * through `onError` and does not affect other subscribers.
     *
     * @param {string} topic
     * @param {any} message
     * @param {Object} [options]
     * @param {boolean} [options.retain=false] - Keep the message for a subscriber
     *   that subscribes later. Intended for a small, fixed set of topics such as
     *   config changes; the retained log is not bounded per subscriber, so do not
     *   use it for an unbounded feed.
     * @returns {number} The number of subscribers the message was queued for.
     */
    publish(topic: string, message: any, options?: {
        retain?: boolean | undefined;
    }): number;
    /**
     * Flush every pending message immediately, bypassing batching.
     * @returns {Promise<void>} Resolves once all subscribers have been drained.
     */
    flush(): Promise<void>;
    /**
     * Snapshot of counters and per-subscriber state.
     *
     * `subscribers` is the live *count*, and the per-subscriber array is `list`.
     * The declared return previously intersected `subscribers: Array<object>`
     * onto `HubStats`, which is how the hub ended up publishing a type saying
     * `subscribers` was an array of records - a number at runtime.
     *
     * @returns {HubStats & {list: HubSubscriberStat[]}}
     */
    stats(): HubStats & {
        list: HubSubscriberStat[];
    };
    /**
     * Close every subscription and release timers. The hub cannot be reused.
     * @returns {void}
     */
    close(): void;
    /**
  
     * Named alias for the `Symbol.dispose` implementation, so callers who do not
  
     * want to reach for the symbol still have something to call.
  
     * @returns {void}
  
     */
    dispose(): void;
    /**
     * Queue a message for one subscriber, applying the slow-consumer policy when
     * the queue is full.
     * @private
     * @param {HubSubscriber} sub
     * @param {any} message
     * @returns {void}
     */
    private _enqueue;
    /**
     * Retain a message for future subscribers of a topic.
     * @private
     * @param {string} topic
     * @param {any} message
     * @returns {void}
     */
    private _retain;
    /**
     * @private
     */
    private _scheduleFlush;
    /**
     * Drain every subscriber with queued work, one batch per send.
     * @private
     * @returns {void}
     */
    private _drain;
    /**
     * @private
     * @returns {Promise<void>}
     */
    private _flushAll;
    /**
     * Build one frame from a subscriber's queue and hand it to the transport.
     * @private
     * @param {HubSubscriber} sub
     * @returns {Promise<void>}
     */
    private _flushSubscriber;
    /**
     * @private
     * @param {any[]} batch
     * @returns {Uint8Array}
     */
    private _encodeBatch;
    /**
     * Detach a subscriber from the hub, optionally closing its transport.
     * @private
     * @param {HubSubscriber} sub
     * @param {{close?: boolean, reason?: string}} [options]
     * @returns {void}
     */
    private _detach;
    /**
     * Report an internal failure through the optional `onError` adapter. A
     * throwing `onError` must not break the hub, so it is swallowed.
     * @private
     * @param {any} err
     * @param {HubSubscriber} sub
     * @returns {void}
     */
    private _notify;
    [Symbol.dispose](): void;
}
export default PowerRealtimeHub;
/**
 * What to do when a subscriber's queue is full.
 *
 * - `drop-oldest` — discard the oldest pending message to make room for the new
 *   one. Best for chat/log-style feeds where the latest state matters most.
 *   **This is the default**: it degrades a slow consumer into a stale one
 *   rather than into a stalled server.
 * - `drop-newest` — refuse the incoming message and keep what is already
 *   queued. Best for ordered, replay-sensitive streams.
 * - `disconnect` — close the subscriber once it falls behind. Use this when
 *   silently delivering stale or missing data is worse than cutting the client
 *   loose so it reconnects with fresh state.
 */
export type SlowConsumerPolicy = "drop-oldest" | "drop-newest" | "disconnect";
/**
 * A live subscription record, as the hub stores it.
 *
 * `SubscriberOptions` describes what a caller may pass; this is what the hub
 * keeps after merging in the per-hub defaults. The two maps holding them were
 * typed `object`, so `id`, `topic`, `queue`, `dropped`, `inFlight`, `maxQueue`,
 * `slowConsumer` and `closed` did not exist at any of the ~30 places the hub
 * reads them.
 */
export type HubSubscriber = {
    id: string;
    topic: string;
    /**
     *   Bounded buffer for this subscriber. A plain array - the hub reads
     *   `.length`, `.push`, `.shift` and `.splice` off it, so a queue typed as an
     *   abstract buffer (the previous declaration) had no `.length` at any of the
     *   five places that check it before enqueueing.
     */
    queue: any[];
    /**
     * - Messages discarded by the slow-consumer policy.
     */
    dropped: number;
    /**
     * - Approximate bytes currently buffered.
     */
    bytesQueued: number;
    /**
     * - Sends currently awaiting the transport.
     */
    inFlight: number;
    maxQueue: number;
    maxBatch: number;
    slowConsumer: SlowConsumerPolicy;
    closed: boolean;
    /**
     * - Invoked with each
     * delivered message, after the transport accepted it, plus the subscriber it
     * was delivered to. Spelled as a call signature so the two arguments the hub
     * passes are checked, and so a handler is callable rather than `Function`.
     */
    handler: (arg0: any, arg1: HubSubscriber) => void;
    /**
     * - Opaque handle the caller attached at subscribe
     * time (a socket, a stream, a peer id). The hub never reads it; it exists so
     * a `send`/`close` adapter can get back to its own connection.
     */
    transport?: any;
};
export type SubscriberOptions = {
    /**
     * - Maximum messages buffered for this
     * subscriber before the slow-consumer policy applies. `0` disables queueing
     * entirely: a full-queue condition is evaluated immediately, which is the
     * right setting when delivery is fire-and-forget.
     */
    maxQueue?: number | undefined;
    /**
     * - Policy applied
     * when `maxQueue` is exceeded.
     */
    slowConsumer?: SlowConsumerPolicy | undefined;
    /**
     * - Maximum messages coalesced into one send.
     */
    maxBatch?: number | undefined;
    /**
     * - Stable identifier; generated when omitted.
     */
    id?: string | undefined;
    /**
     * - Carried through to the stored
     * {@link HubSubscriber} untouched, for the caller's own `send`/`close`
     * adapters to use.
     */
    transport?: any;
};
/**
 * One entry of the per-subscriber array in {@link PowerRealtimeHub#stats}.
 */
export type HubSubscriberStat = {
    id: string;
    topic: string;
    /**
     * - Messages waiting for this subscriber right now.
     */
    queued: number;
    dropped: number;
    inFlight: number;
    maxQueue: number;
    slowConsumer: SlowConsumerPolicy;
};
export type HubStats = {
    /**
     * - Current live subscription count.
     */
    subscribers: number;
    /**
     * - Number of topics with at least one subscriber.
     */
    topics: number;
    /**
     * - Total messages accepted by `publish`.
     */
    published: number;
    /**
     * - Total messages handed to a `send` adapter.
     */
    delivered: number;
    /**
     * - Total messages discarded by a policy.
     */
    dropped: number;
    /**
     * - Subscribers closed for falling behind.
     */
    disconnected: number;
    /**
     * - Approximate bytes handed to the adapter.
     */
    bytesOut: number;
};
export type HubOptions = {
    /**
     * - Required
     */
    send: (arg0: object, arg1: Uint8Array) => (void | Promise<void>);
    /**
     * - Opt in to
     * metrics: `true` registers this helper in the shared collector, or pass a
     * collector of your own. Off by default, so the common case allocates nothing.
     * See `guides/metrics.md`.
     * transport adapter, called as `send(subscriber, frame)`. Return a promise if
     * the transport is async; the hub tracks in-flight sends per subscriber.
     */
    observability?: boolean | import("./metrics.js").MetricsCollector | undefined;
    /**
     * - Optional
     * adapter called when the hub closes a subscriber for falling behind or on
     * `close()`. Takes the same `(subscriber, reason)` pair as `send` plus why
     * it happened - `'unsubscribe'`, `'slow-consumer'` or `'hub-closed'`. The
     * published type previously declared one parameter, while the guide, the
     * runtime and every test all pass and read two.
     */
    close?: ((arg0: object, arg1: string) => (void | Promise<void>)) | undefined;
    /**
     * - Coalesce messages published within the
     * same microtask into a single `send`. Turn off for tests or transports that
     * cannot handle several frames at once.
     */
    batch?: boolean | undefined;
    /**
     * - Optional macrotask delay before
     * flushing, to widen the coalescing window beyond a single microtask.
     */
    batchDelayMs?: number | undefined;
    /**
     * - Payload codec for outgoing frames.
     */
    codec?: "json" | "raw" | undefined;
    /**
     * - Called when the `send`
     * adapter rejects or throws, instead of leaving an unhandled rejection.
     */
    onError?: ((arg0: Error, arg1: object) => void) | undefined;
    /**
     * - Clock override, for tests.
     */
    now?: (() => number) | undefined;
};
