export { READY_STATE };
/**
 * Reconnecting WebSocket client with explicit back-pressure.
 *
 * @example
 * const client = new PowerWebSocketClient({
 *   url: 'wss://example.test/feed',
 *   highWaterMarkBytes: 1 << 20,
 *   onPause: () => feed.pause(),
 *   onResume: () => feed.resume(),
 *   onMessage: (msg) => render(msg),
 * });
 *
 * client.on('open', () => hub.subscribe('feed', (m) => client.send(m)));
 */
export class PowerWebSocketClient {
    /**
     * @param {WebSocketClientOptions} options
     */
    constructor(options?: WebSocketClientOptions);
    url: string;
    protocols: string | string[] | undefined;
    _WS: Function;
    _WSStream: any;
    _codec: "json" | "raw";
    _connectTimeoutMs: number;
    _highWaterMark: number;
    _maxPayloadSizeBytes: number;
    _lowWaterMark: number;
    _pollBase: number;
    _pollMax: number;
    _heartbeatIntervalMs: number;
    _heartbeatTimeoutMs: number;
    _maxReconnectAttempts: number;
    _maxReconnectElapsedMs: number;
    _reconnectStartedAt: number | null;
    _reconnectBaseMs: number;
    _reconnectMaxMs: number;
    _autoReconnect: boolean;
    _nonRetryableCloseCodes: number[];
    _reconnectOnHeartbeatTimeout: boolean;
    _on: {
        message: Function | null;
        open: Function | null;
        close: Function | null;
        error: Function | null;
        pause: Function | null;
        resume: Function | null;
    };
    _socket: any;
    /** @type {WritableStreamDefaultWriter|null} */
    _writer: WritableStreamDefaultWriter | null;
    /** @type {ReadableStreamDefaultReader|null} */
    _streamReader: ReadableStreamDefaultReader | null;
    _binaryTypeUnsupported: boolean;
    _reportedBinaryTypeUnsupported: boolean;
    /** @type {0|1|2|3} */
    _state: 0 | 1 | 2 | 3;
    _closedByUser: boolean;
    _reconnectAttempts: number;
    _reconnectExhaustedBy: string | null;
    _connectTimer: any;
    _pollTimer: any;
    _heartbeatTimer: any;
    _heartbeatDeadline: any;
    _reconnectTimer: any;
    _paused: boolean;
    _lastPollInterval: number;
    _lastPongAt: number;
    _pingSentAt: number;
    /** decorrelated-jitter backoff cursor, in ms */
    _reconnectDelay: any;
    rtt: PowerHistogram;
    _counters: {
        sent: number;
        received: number;
        drops: number;
        decodeErrors: number;
        oversizeFrames: number;
        reconnects: number;
        heartbeatTimeouts: number;
        heartbeats: number;
    };
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
    /**
     * Which back-pressure mechanism is in use.
     *
     * - `'streams'` — a `WebSocketStream` writer is available, so real
     *   Streams back-pressure applies and `writer.ready` is the signal.
     * - `'watermark'` — `bufferedAmount` is polled against the configured marks.
     * - `'none'` — the socket is not open, so neither is active.
     *
     * @returns {BackpressureMode}
     */
    get backpressureMode(): BackpressureMode;
    /**
     * @returns {0|1|2|3} The socket's ready state, mirroring the platform
     *   `WebSocket.readyState` constants (`READY_STATE` above). Spelled as the
     *   literal union rather than `WebSocketReadyState`, which is a `lib.dom`
     *   alias - referencing it made the shipped declaration depend on a DOM lib
     *   that a Node consumer may not have. Two corrections landed here in one
     *   pass: an earlier revision claimed this was a state *name* and declared it
     *   `string` (producing 11 "no overlap" diagnostics on every
     *   `_state === READY_STATE.X` comparison), and the next used the DOM alias.
     */
    get readyState(): 0 | 1 | 2 | 3;
    /** @returns {boolean} Whether the socket is open and accepting data. */
    get isOpen(): boolean;
    /**
     * Whether the producer is currently paused for back-pressure.
     * @returns {boolean}
     */
    get paused(): boolean;
    /**
     * Bytes the socket has buffered and not yet handed to the network.
     * @returns {number}
     */
    get bufferedAmount(): number;
    /**
     * Open the connection. Safe to call again to reconnect deliberately.
     * @returns {Promise<void>} Resolves once the socket is open, rejects on a
     *   failed connect or a connect timeout.
     */
    connect(): Promise<void>;
    /**
     * Close the connection and stop reconnecting.
     * @param {number} [code=1000] - WebSocket close code.
     * @param {string} [reason=''] - Human-readable reason.
     * @returns {void}
     */
    close(code?: number, reason?: string): void;
    /**
  
     * Named alias for the `Symbol.dispose` implementation, so callers who do not
  
     * want to reach for the symbol still have something to call.
  
     * @returns {void}
  
     */
    dispose(): void;
    /**
     * Send a message, applying back-pressure.
     *
     * With the Streams tier this awaits `writer.ready`, so the returned promise
     * resolves only when the socket has room. With the watermark tier it
     * resolves as soon as the frame is handed to `send()`, and the *producer* is
     * expected to honour `onPause`/`onResume` — because at that point the browser
     * has already buffered it and there is nothing left to await.
     *
     * @param {any} message
     * @param {{dropOnBackpressure?: boolean}} [options] - When the socket is
     *   over its high-water mark, drop the message instead of queueing it. Use for
     *   telemetry where a gap is better than growing an unbounded buffer.
     * @returns {Promise<boolean>} `true` when the frame was handed to the socket.
     */
    send(message: any, options?: {
        dropOnBackpressure?: boolean;
    }): Promise<boolean>;
    /**
     * @private
     * @param {Uint8Array} frame
     * @param {Object} options
     * @returns {Promise<boolean>}
     */
    private _transmit;
    /**
     * Send an **already-framed** payload, applying the same back-pressure.
     *
     * This is the correct adapter for `PowerRealtimeHub`: the hub hands its
     * `send` adapter a frame it has already encoded, and passing that to
     * {@link PowerWebSocketClient#send} would try to JSON-serialise the bytes and
     * corrupt them. Use this when the payload is already a frame, and `send()`
     * for a plain value.
     *
     * @param {Uint8Array} frame - A payload from `encodeMessage` /
     *   `frameEncodedJson`.
     * @param {Object} [options] - Same shape as {@link send}.
     * @returns {Promise<boolean>} `true` when the frame was handed to the socket.
     */
    sendFrame(frame: Uint8Array, options?: Object): Promise<boolean>;
    /**
     * Register a lifecycle handler.
     * @param {'message'|'open'|'close'|'error'|'pause'|'resume'} type
     * @param {Function} handler
     * @returns {function():void} An unsubscribe function.
     */
    on(type: "message" | "open" | "close" | "error" | "pause" | "resume", handler: Function): () => void;
    /**
     * Remove a registered handler.
     * @param {'message'|'open'|'close'|'error'|'pause'|'resume'} type
     * @returns {void}
     */
    off(type: "message" | "open" | "close" | "error" | "pause" | "resume"): void;
    /**
     * Counters plus heartbeat statistics.
     * @returns {object}
     */
    stats(): object;
    /**
     * Alias for {@link stats}, so a caller who learned `getStats()` from
     * `PowerPool` — the one class that has always spelled it this way — is not
     * handed `TypeError: x.getStats is not a function` here.
     *
     * Nine helpers spell the reporting method `stats()` and `PowerPool` spelled it
     * `getStats()`, with no stated rule and nothing pinning it, which reached the
     * documentation as a false claim (`guides/metrics.md`, `llm.txt`). Both
     * spellings work everywhere now. `stats()` is canonical and this delegates to
     * it; `PowerPool` keeps `getStats` because renaming the largest surface in the
     * library would be a breaking change.
     *
     * Written out per class rather than installed on the prototype on purpose: a
     * dynamic `Object.defineProperty` is invisible to `tsc`, so the generated
     * `types/` omitted it and a TypeScript caller got a type error on a method
     * that worked at runtime. That was the first implementation.
     *
     * **No `@returns` tag, and that is load-bearing.** The first version carried a
     * hand-copied copy of the `stats()` return shape, on the reasoning that an
     * explicit type was safer. It is not: the copy went stale the moment a
     * concurrent change added `staleServes` and `expirations` to `PowerCache`
     * `.stats()`, and `test/statsNaming.test.js` failed. Inference gives a
     * byte-identical published type and cannot drift, because there is nothing to
     * keep in sync. `test/types.test-d.ts` asserts the two are mutually assignable,
     * which is the property a consumer relies on.
     */
    getStats(): object;
    /**
     * Send an application-level ping. Only useful when the protocol allows it;
     * otherwise rely on the heartbeat, which uses whatever the transport offers.
     * @returns {void}
     */
    ping(): void;
    /**
     * @private
     * @returns {Promise<void>}
     */
    private _open;
    /**
     * @param {(err?: any) => void} done Settles the pending connect exactly once.
     * @private
     */
    private _handleOpen;
    /**
     * Read the streams tier's inbound frames until the stream ends.
     *
     * A `WebSocketStream` has no `message` event: inbound frames arrive from
     * `readable`, so **nothing arrives unless someone takes a reader.** That is
     * the whole of the fix — the loop itself is ordinary.
     *
     * Two decisions worth stating:
     *
     * - **The reader is retained**, as `_streamReader`, so `close()` can cancel it.
     *   A pending `read()` keeps the stream locked; dropping the handle would leak
     *   the lock on every reconnect, and the replacement stream would then fail to
     *   hand out a reader at all.
     * - **A read failure is reported, not thrown, and deliberately does not open a
     *   reconnect.** `error` is what the caller already handles, and synthesising a
     *   close would invent a `close` event and a close code the peer never sent.
     *   The trade-off is that a stream that fails *after* opening leaves a deaf
     *   open socket, which is the shape this method exists to remove — so it is a
     *   real limitation rather than a settled design, and it needs a decision about
     *   what a fabricated close should look like before it can be changed. Recorded
     *   in the audit that found it rather than settled here.
     *
     * @private
     * @returns {void}
     */
    private _startStreamPump;
    /**
     * @param {{data?: any}} event The DOM `MessageEvent`, or the bare payload when
     *   the caller delivers one directly - hence `event?.data ?? event`.
     * @private
     */
    private _handleMessage;
    /**
     * @param {{code?: number, reason?: string}} [event] The DOM `CloseEvent`,
     *   absent on a synthetic close.
     * @private
     */
    private _handleClose;
    /**
     * @param {any} err Whatever the platform or the caller reported. `any` because
     *   the WS `error` event carries no guaranteed shape.
     * @private
     */
    private _handleError;
    /**
     * The reply to a heartbeat ping.
     *
     * Two things depend on it and neither happened before this existed:
     * `_heartbeatDeadline` was never cleared, so on a `ws` socket — where `ping()`
     * exists and the reply comes back as a `pong` event — **every healthy
     * connection was closed with 4000 and reconnected, forever**; and in a browser,
     * where there is no `ping()` at all, the heartbeat was inert and
     * `stats().rtt` was permanently empty.
     *
     * The `canPing` read is the honest answer for a browser: the transport cannot
     * ping, so RTT is unobservable rather than zero, and a dashboard that shows
     * `0 ms` for a connection it never measured is making a claim it did not earn.
     *
     * @private
     * @returns {void}
     */
    private _handlePong;
    /**
     * Poll `bufferedAmount`, pausing and resuming the producer across the marks.
     * The interval backs off while paused so a stuck socket does not spin.
     * @private
     */
    private _schedulePoll;
    /**
     * @private
     */
    private _stopPoll;
    /**
     * @private
     */
    private _tickWatermark;
    /**
     * @param {boolean} paused
     * @private
     */
    private _setPaused;
    /**
     * @private
     */
    private _scheduleHeartbeat;
    /**
     * @private
     */
    private _tickHeartbeat;
    /**
     * @private
     */
    private _onHeartbeatTimeout;
    /**
     * Decorrelated-jitter backoff, per AWS "Exponential Backoff and Jitter"
     * (2015). It decorrelates far better than full jitter under load, which
     * matters here because a server restart otherwise produces a synchronised
     * reconnect stampede from every client at once.
     * @private
     * @returns {number} Delay in ms.
     */
    private _nextReconnectDelay;
    /**
     * @private
     */
    private _scheduleReconnect;
    /**
     * @private
     */
    private _clearConnectTimer;
    /**
     * @private
     */
    private _clearHeartbeat;
    /**
     * @private
     */
    private _clearTimers;
    /**
     * @param {string} type One of the keys of `this._on`.
     * @param {...any} args
     * @private
     */
    private _emit;
    [Symbol.dispose](): void;
    /**
     * Asynchronous disposal hook, so `await using client = new PowerWebSocketClient(…)`
     * works alongside the synchronous `using`.
     *
     * **A delegation rather than a graceful path, and that is deliberate.**
     * `PowerRealtimeHub`'s `asyncDispose` awaits `flush()` first because it has real
     * pending work; this client's teardown is `close()`, which is synchronous and
     * already complete. Inventing an awaitable variant of it would be a promise
     * that resolves immediately and implied a graceful path that does not exist —
     * the `PowerPool` version drains because it has something to drain.
     *
     * @returns {Promise<void>}
     */
    [Symbol.asyncDispose](): Promise<void>;
}
export default PowerWebSocketClient;
export type BackpressureMode = "watermark" | "streams" | "none";
export type WebSocketClientOptions = {
    /**
     * - The `ws://` or `wss://` URL.
     */
    url: string;
    /**
     * - Constructor override, for tests or a
     * non-global implementation. Defaults to `globalThis.WebSocket`.
     */
    WebSocketImpl?: Function | undefined;
    /**
     * - `WebSocketStream` constructor
     * override. When absent (or when the platform lacks it) the client falls back
     * to `bufferedAmount` watermarks.
     */
    WebSocketStreamImpl?: Function | undefined;
    /**
     * - Frame codec handed to the codec
     * module.
     */
    codec?: "json" | "raw" | undefined;
    /**
     * - Abort the connect attempt after
     * this long. `0` disables the timeout.
     */
    connectTimeoutMs?: number | undefined;
    /**
     * - Frames larger than this are
     * **reported, not prevented** — and the distinction is the point, so read this
     * before relying on it.
     *
     * By the time a `message` event fires, the platform has already received and
     * materialised the whole frame. Nothing at this layer can stop that allocation,
     * so this option **counts** the oversized frame (`stats().oversizeFrames`) and
     * emits an `error` saying what arrived. It is observability, not a guard: a
     * number that reads like a limit and is not one is worse than no number, which
     * is why it is described this way in the option, in the error message and here.
     *
     * **Prevention belongs at the peer that produces the frame.** And the codec is
     * already safe regardless: `decodeMessage` validates a declared payload length
     * against the bytes actually present *before* slicing, so a frame lying about
     * its size throws instead of reserving anything, and the payload is a view
     * rather than a copy. The incremental decoder's equivalent bound —
     * `createFrameDecoder`'s `maxFrameBytes` — is **required** rather than
     * defaulted, because a peer that sends a header and then stops would otherwise
     * pin its buffer at whatever size it named.
     *
     * Defaults to `Infinity`, which disables the report; `0` disables it too, the
     * same convention `highWaterMarkBytes: 0` uses in this class. Set it to the
     * largest frame your peer should ever send, and alert on `oversizeFrames`.
     */
    maxPayloadSizeBytes?: number | undefined;
    /**
     * - Above this `bufferedAmount`
     * the producer is paused. 1 MiB by default.
     */
    highWaterMarkBytes?: number | undefined;
    /**
     * - Below this, the producer is
     * resumed. Must be below the high-water mark.
     */
    lowWaterMarkBytes?: number | undefined;
    /**
     * - Base interval for the watermark
     * poll. It backs off up to `maxPollIntervalMs` while paused, so a stuck
     * socket does not spin the event loop.
     */
    pollIntervalMs?: number | undefined;
    /**
     * - Sub-protocols forwarded to the
     * `WebSocket` / `WebSocketStream` constructor.
     */
    protocols?: string | string[] | undefined;
    /**
     * - Ceiling for the backed-off poll.
     */
    maxPollIntervalMs?: number | undefined;
    /**
     * - Send a ping at this interval.
     * `0` disables heartbeats.
     */
    heartbeatIntervalMs?: number | undefined;
    /**
     * - Declare the socket dead if a
     * pong does not arrive in this long.
     */
    heartbeatTimeoutMs?: number | undefined;
    /**
     * - Wall-clock ceiling on
     * one reconnect run, in milliseconds. Unlike {@link maxReconnectAttempts},
     * which counts attempts, this bounds the *time* spent retrying — so a backoff
     * schedule that has stretched its delay out is stopped on wall-clock grounds
     * rather than waiting for an attempt count nobody can predict.
     *
     * Defaults to `Infinity`, which is **no bound** and preserves today's
     * behaviour. That default is the anti-pattern named in GAP-010 — *"Should I
     * reconnect a WebSocket forever? No. Set a maximum retry count (10–15) or a
     * maximum elapsed time (2–5 minutes)"* — and a finite default is a breaking
     * change, so it is scheduled for 3.0 rather than smuggled into this release.
     * Set it here for now.
     *
     * The budget covers **one outage**: it is reset when a connection opens, so a
     * long-lived connection that drops an hour later gets a fresh window rather
     * than inheriting the previous one's exhaustion. That is the same window
     * `maxReconnectAttempts` bounds, and the two compose.
     */
    maxReconnectElapsedMs?: number | undefined;
    /**
     * - `Infinity` retries
     * forever with decorrelated-jitter backoff.
     */
    maxReconnectAttempts?: number | undefined;
    /**
     * - Base delay for the backoff.
     */
    reconnectBaseMs?: number | undefined;
    /**
     * - Ceiling for the backoff.
     */
    reconnectMaxMs?: number | undefined;
    /**
     * - Reconnect on an unexpected close.
     */
    autoReconnect?: boolean | undefined;
    /**
     * - Close codes that **end**
     * the client rather than being retried. RT-014.
     *
     * **Opt-in, and `[]` by default, so nothing changes until it is configured.**
     * A `close` event whose `code` is in this list skips the whole reconnect
     * decision: no attempt is counted, no backoff delay is armed, and
     * `stats().reconnectExhaustedBy` becomes `'close-code'`. The client is left
     * exactly where a caller-initiated `close()` leaves it — `readyState` `3`
     * (`CLOSED`), the `close` event already emitted, no timer pending.
     *
     * The reason it exists is the stampede the backoff cannot prevent. A `1008`
     * (policy violation), `1001` (going away) or `1002` (protocol error) close is
     * the *same* answer for every client of a service, delivered immediately, so
     * decorrelated jitter has nothing to decorrelate — it spreads the retries
     * after the decision, not the decision itself. Declaring the code makes "this
     * is not retryable" a property of the application rather than a property of
     * the outage.
     *
     * **The check runs before every other input to the reconnect decision** —
     * `autoReconnect`, `maxReconnectAttempts`, `maxReconnectElapsedMs` — and so
     * before any future `shouldReconnect` callback, because a caller's own
     * predicate must not be able to re-enable a reconnect on a code the caller
     * just declared non-retryable. No `shouldReconnect` option exists on this
     * class today, so the inputs being short-circuited are the built-in ones.
     *
     * **A numeric string in the list matches the numeric `event.code`**, so
     * `'1008'` and `1008` behave identically. A list that silently matched
     * nothing is the one failure direction this option must not have: a code
     * read out of JSON, an environment variable or a query string arrives as a
     * string, and an ineffective list is indistinguishable from no list at all —
     * the client reconnects for ever, which is the defect being fixed. For the
     * same reason RT-013 validates `maxReconnectAttempts` rather than coercing
     * it, an entry that is not a code (`NaN`, `null`, `''`, `'close'`, an object)
     * **throws** at construction instead of being dropped: a dropped entry is a
     * list the caller believes in and the client ignores. Duplicates and `[]`
     * are legal.
     *
     * A pending `connect()` promise is unaffected. A close arriving before `open`
     * settles it with the close event — the pre-existing RT-001 path, unchanged —
     * and a close after `open` has nothing left to settle. Call `connect()` again
     * to retry deliberately; the client is not latched.
     */
    nonRetryableCloseCodes?: number[] | undefined;
    /**
     * - Reconnect when a
     * heartbeat goes unanswered. A TCP connection that is silently dead is common
     * behind proxies and load balancers, and a socket can sit in `OPEN` forever
     * while nothing gets through.
     */
    reconnectOnHeartbeatTimeout?: boolean | undefined;
    /**
     * - Drop frames when the
     * producer is paused by the high-water mark instead of queueing them.
     */
    dropOnBackpressure?: boolean | undefined;
    /**
     * - Called with each decoded message.
     */
    onMessage?: Function | undefined;
    /**
     * - Called once the socket reaches `OPEN`.
     */
    onOpen?: Function | undefined;
    /**
     * - Called with the close code and reason.
     */
    onClose?: Function | undefined;
    /**
     * - Called with each transport error.
     */
    onError?: Function | undefined;
    /**
     * - Called when the high-water mark is crossed.
     */
    onPause?: Function | undefined;
    /**
     * - Called when `bufferedAmount` drains below
     * the low-water mark.
     *
     * These were written as one line - `[onOpen] / [onClose] / [onError] / ...` -
     * which reads fine and parses as exactly one property. `onClose`, `onError`,
     * `onPause` and `onResume` were therefore invisible to the type system while
     * being fully supported at runtime, and every call site that passed one was an
     * error. Five `@property` lines instead of one shorthand, for the same length.
     */
    onResume?: Function | undefined;
    /**
     * - Histogram for heartbeat RTT. One is
     * created when omitted.
     */
    rtt?: PowerHistogram | undefined;
    /**
     * - Opt in to
     * metrics: `true` registers this helper in the shared collector, or pass a
     * collector of your own. Off by default, so the common case allocates nothing.
     */
    observability?: boolean | import("./metrics.js").MetricsCollector | undefined;
};
export type WebSocketReadyState = "connecting" | "open" | "closing" | "closed";
import { READY_STATE } from './constants.js';
import { PowerHistogram } from './powerHistogram.js';
