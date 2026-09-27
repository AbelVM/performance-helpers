/** @typedef {'connecting'|'open'|'closing'|'closed'} WebSocketReadyState */
/** The four states of a socket's lifecycle, as constants. */
export const READY_STATE: Readonly<{
    CONNECTING: 0;
    OPEN: 1;
    CLOSING: 2;
    CLOSED: 3;
}>;
/** @typedef {'watermark'|'streams'|'none'} BackpressureMode */
/**
 * @typedef {object} WebSocketClientOptions
 * @property {string} url - The `ws://` or `wss://` URL.
 * @property {function} [WebSocketImpl] - Constructor override, for tests or a
 *   non-global implementation. Defaults to `globalThis.WebSocket`.
 * @property {function} [WebSocketStreamImpl] - `WebSocketStream` constructor
 *   override. When absent (or when the platform lacks it) the client falls back
 *   to `bufferedAmount` watermarks.
 * @property {'json'|'raw'} [codec='json'] - Frame codec handed to the codec
 *   module.
 * @property {number} [connectTimeoutMs=10000] - Abort the connect attempt after
 *   this long. `0` disables the timeout.
 * @property {number} [highWaterMarkBytes=1<<20] - Above this `bufferedAmount`
 *   the producer is paused. 1 MiB by default.
 * @property {number} [lowWaterMarkBytes=1<<19] - Below this, the producer is
 *   resumed. Must be below the high-water mark.
 * @property {number} [pollIntervalMs=20] - Base interval for the watermark
 *   poll. It backs off up to `maxPollIntervalMs` while paused, so a stuck
 *   socket does not spin the event loop.
 * @property {number} [maxPollIntervalMs=250] - Ceiling for the backed-off poll.
 * @property {number} [heartbeatIntervalMs=30000] - Send a ping at this interval.
 *   `0` disables heartbeats.
 * @property {number} [heartbeatTimeoutMs=10000] - Declare the socket dead if a
 *   pong does not arrive in this long.
 * @property {number} [maxReconnectAttempts=Infinity] - `Infinity` retries
 *   forever with decorrelated-jitter backoff.
 * @property {number} [reconnectBaseMs=500] - Base delay for the backoff.
 * @property {number} [reconnectMaxMs=30000] - Ceiling for the backoff.
 * @property {boolean} [autoReconnect=true] - Reconnect on an unexpected close.
 * @property {boolean} [reconnectOnHeartbeatTimeout=true] - Reconnect when a
 *   heartbeat goes unanswered. A TCP connection that is silently dead is common
 *   behind proxies and load balancers, and a socket can sit in `OPEN` forever
 *   while nothing gets through.
 * @property {Function} [onMessage] - Called with each decoded message.
 * @property {Function} [onOpen] / [onClose] / [onError] / [onPause] / [onResume]
 *   - Lifecycle and back-pressure callbacks.
 * @property {PowerHistogram} [rtt] - Histogram for heartbeat RTT. One is
 *   created when omitted.
 */
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
    [x: number]: () => void;
    /**
     * @param {WebSocketClientOptions} options
     */
    constructor(options?: WebSocketClientOptions);
    url: string;
    protocols: any;
    _WS: Function;
    _WSStream: any;
    _codec: "json" | "raw";
    _connectTimeoutMs: number;
    _highWaterMark: number;
    _lowWaterMark: number;
    _pollBase: number;
    _pollMax: number;
    _heartbeatIntervalMs: number;
    _heartbeatTimeoutMs: number;
    _maxReconnectAttempts: number;
    _reconnectBaseMs: number;
    _reconnectMaxMs: number;
    _autoReconnect: boolean;
    _reconnectOnHeartbeatTimeout: boolean;
    _on: {
        message: Function | null;
        open: Function | null;
        close: any;
        error: any;
        pause: any;
        resume: any;
    };
    _socket: any;
    /** @type {WritableStreamDefaultWriter|null} */
    _writer: WritableStreamDefaultWriter | null;
    _state: 3;
    _closedByUser: boolean;
    _reconnectAttempts: number;
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
        reconnects: number;
        heartbeatTimeouts: number;
    };
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
    /** @returns {WebSocketReadyState} The socket's numeric ready state. */
    get readyState(): WebSocketReadyState;
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
     * Send a message, applying back-pressure.
     *
     * With the Streams tier this awaits `writer.ready`, so the returned promise
     * resolves only when the socket has room. With the watermark tier it
     * resolves as soon as the frame is handed to `send()`, and the *producer* is
     * expected to honour `onPause`/`onResume` — because at that point the browser
     * has already buffered it and there is nothing left to await.
     *
     * @param {any} message
     * @param {Object} [options]
     * @param {boolean} [options.dropOnBackpressure=false] - When the socket is
     *   over its high-water mark, drop the message instead of queueing it. Use for
     *   telemetry where a gap is better than growing an unbounded buffer.
     * @returns {Promise<boolean>} `true` when the frame was handed to the socket.
     */
    send(message: any, options?: {
        dropOnBackpressure?: boolean | undefined;
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
     * @private
     */
    private _handleOpen;
    /**
     * @private
     */
    private _handleMessage;
    /**
     * @private
     */
    private _handleClose;
    /**
     * @private
     */
    private _handleError;
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
     * @private
     */
    private _emit;
}
export default PowerWebSocketClient;
export type WebSocketReadyState = "connecting" | "open" | "closing" | "closed";
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
     * - Reconnect when a
     * heartbeat goes unanswered. A TCP connection that is silently dead is common
     * behind proxies and load balancers, and a socket can sit in `OPEN` forever
     * while nothing gets through.
     */
    reconnectOnHeartbeatTimeout?: boolean | undefined;
    /**
     * - Called with each decoded message.
     */
    onMessage?: Function | undefined;
    /**
     * / [onClose] / [onError] / [onPause] / [onResume]
     * - Lifecycle and back-pressure callbacks.
     */
    onOpen?: Function | undefined;
    /**
     * - Histogram for heartbeat RTT. One is
     * created when omitted.
     */
    rtt?: PowerHistogram | undefined;
};
import { PowerHistogram } from './powerHistogram.js';
