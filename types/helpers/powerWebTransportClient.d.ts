/** @typedef {'connecting'|'open'|'closing'|'closed'} WebTransportReadyState */
/**
 * The four states of a transport's lifecycle, as constants.
 *
 * Mirrors `READY_STATE` from `powerWebSocketClient` so callers can compare
 * with `===` across both transports.
 */
export const READY_STATE: Readonly<{
    CONNECTING: 0;
    OPEN: 1;
    CLOSING: 2;
    CLOSED: 3;
}>;
/** @typedef {'streams'|'none'} BackpressureMode */
/**
 * @typedef {object} WebTransportClientOptions
 * @property {string} url - The `https://` URL.
 * @property {Function} [WebTransportImpl] - Constructor override, for tests or a
 *   non-global implementation. Defaults to `globalThis.WebTransport`.
 * @property {'json'|'raw'} [codec='json'] - Frame codec handed to the codec
 *   module.
 * @property {number} [connectTimeoutMs=10000] - Abort the connect attempt after
 *   this long. `0` disables the timeout.
 * @property {number} [maxPayloadSizeBytes=Infinity] - Frames larger than this are
 *   **reported, not prevented**. Counts `oversizeFrames` and emits `error`.
 * @property {number} [heartbeatIntervalMs=30000] - Send a heartbeat at this
 *   interval. `0` disables heartbeats.
 * @property {number} [heartbeatTimeoutMs=10000] - Declare the transport dead if
 *   a heartbeat reply is not received in this long.
 * @property {number} [maxReconnectAttempts=Infinity] - `Infinity` retries
 *   forever with decorrelated-jitter backoff.
 * @property {number} [maxReconnectElapsedMs=Infinity] - Wall-clock ceiling on
 *   one reconnect run, in milliseconds.
 * @property {number} [reconnectBaseMs=500] - Base delay for the backoff.
 * @property {number} [reconnectMaxMs=30000] - Ceiling for the backoff.
 * @property {boolean} [autoReconnect=true] - Reconnect on an unexpected close.
 * @property {boolean} [reconnectOnHeartbeatTimeout=true] - Reconnect when a
 *   heartbeat goes unanswered.
 * @property {Function} [onMessage] - Called with each decoded message.
 * @property {Function} [onOpen] - Called once the transport reaches `OPEN`.
 * @property {Function} [onClose] - Called with the close code and reason.
 * @property {Function} [onError] - Called with each transport error.
 * @property {PowerHistogram} [rtt] - Histogram for heartbeat RTT. One is
 *   created when omitted.
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] - Opt in to
 *   metrics: `true` registers this helper in the shared collector, or pass a
 *   collector of your own. Off by default.
 */
/**
 * RT-002: a `PowerWebTransportClient` that mirrors the `PowerWebSocketClient`
 * public API over WebTransport streams.
 *
 * The transport differences this hides from callers:
 *
 * - **Back-pressure** is the stream's `ready` promise, not `bufferedAmount`.
 * - **Heartbeat** is application-level: a small frame sent on the writable
 *   stream, with a deadline armed on the readable side.
 * - **Reconnection** is the same decorrelated-jitter shape as the WebSocket
 *   client, because the hub and the caller should not have to branch.
 *
 * @example
 * const client = new PowerWebTransportClient({
 *   url: 'https://example.test/feed',
 *   onMessage: (msg) => hub.send(msg),
 * });
 * client.connect();
 */
export class PowerWebTransportClient {
    /**
     * @param {WebTransportClientOptions} options
     */
    constructor(options?: WebTransportClientOptions);
    url: string;
    /** @type {WritableStreamDefaultWriter|null} */
    /** @type {ReadableStreamDefaultReader|null} */
    /** @type {TransformStream|undefined} */
    /** @type {AbortController|null} */
    /** @type {0|1|2|3} */
    rtt: PowerHistogram;
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
    /** @returns {BackpressureMode} */
    get backpressureMode(): BackpressureMode;
    /** @returns {0|1|2|3} */
    get readyState(): 0 | 1 | 2 | 3;
    /** @returns {boolean} */
    get isOpen(): boolean;
    /**
     * Open the connection. Safe to call again to reconnect deliberately.
     * @returns {Promise<void>}
     */
    connect(): Promise<void>;
    /**
     * Close the connection and stop reconnecting.
     * @param {number} [code=1000] - Close code.
     * @param {string} [reason=''] - Human-readable reason.
     * @returns {void}
     */
    close(code?: number, reason?: string): void;
    /**
     * Named alias for `Symbol.dispose`.
     * @returns {void}
     */
    dispose(): void;
    /**
     * Send a message, applying back-pressure.
     *
     * @param {any} message
     * @param {{dropOnBackpressure?: boolean}} [options]
     * @returns {Promise<boolean>} `true` when the frame was handed to the transport.
     */
    send(message: any, options?: {
        dropOnBackpressure?: boolean;
    }): Promise<boolean>;
    /**
     * Send an already-framed payload.
     * @param {Uint8Array} frame
     * @param {Object} [options]
     * @returns {Promise<boolean>}
     */
    sendFrame(frame: Uint8Array, options?: Object): Promise<boolean>;
    /**
     * Register a lifecycle handler.
     * @param {'message'|'open'|'close'|'error'} type
     * @param {Function} handler
     * @returns {function():void}
     */
    on(type: "message" | "open" | "close" | "error", handler: Function): () => void;
    /**
     * Remove a registered handler.
     * @param {'message'|'open'|'close'|'error'} type
     * @returns {void}
     */
    off(type: "message" | "open" | "close" | "error"): void;
    /**
     * Counters plus heartbeat statistics.
     * @returns {object}
     */
    stats(): object;
    /**
     * Alias for {@link stats}.
     * @returns {object}
     */
    getStats(): object;
    /**
     * Send an application-level ping.
     * @returns {void}
     */
    ping(): void;
    /**
     * @private
     * @returns {Promise<void>}
     */
    /**
     * @param {(err?: any) => void} done
     * @private
     */
    /**
     * @private
     */
    /**
     * @param {*} data
     * @private
     */
    /**
     * @param {{code?: number, reason?: string}} [event]
     * @private
     */
    /**
     * @param {{code?: number, reason?: string}} [event]
     * @private
     */
    /**
     * @param {any} err
     * @private
     */
    /**
     * @private
     */
    /**
     * @private
     */
    /**
     * @private
     */
    /**
     * @private
     */
    /**
     * @private
     */
    /**
     * @private
     * @returns {number}
     */
    /**
     * @private
     */
    /**
     * @private
     */
    /**
     * @param {string} type
     * @param {...any} args
     * @private
     */
    /**
     * @param {Uint8Array} frame
     * @private
     * @returns {Promise<boolean>}
     */
    [Symbol.dispose](): void;
    /**
     * Asynchronous disposal hook.
     * @returns {Promise<void>}
     */
    [Symbol.asyncDispose](): Promise<void>;
}
export type WebTransportReadyState = "connecting" | "open" | "closing" | "closed";
export type BackpressureMode = "streams" | "none";
export type WebTransportClientOptions = {
    /**
     * - The `https://` URL.
     */
    url: string;
    /**
     * - Constructor override, for tests or a
     * non-global implementation. Defaults to `globalThis.WebTransport`.
     */
    WebTransportImpl?: Function | undefined;
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
     * **reported, not prevented**. Counts `oversizeFrames` and emits `error`.
     */
    maxPayloadSizeBytes?: number | undefined;
    /**
     * - Send a heartbeat at this
     * interval. `0` disables heartbeats.
     */
    heartbeatIntervalMs?: number | undefined;
    /**
     * - Declare the transport dead if
     * a heartbeat reply is not received in this long.
     */
    heartbeatTimeoutMs?: number | undefined;
    /**
     * - `Infinity` retries
     * forever with decorrelated-jitter backoff.
     */
    maxReconnectAttempts?: number | undefined;
    /**
     * - Wall-clock ceiling on
     * one reconnect run, in milliseconds.
     */
    maxReconnectElapsedMs?: number | undefined;
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
     * heartbeat goes unanswered.
     */
    reconnectOnHeartbeatTimeout?: boolean | undefined;
    /**
     * - Called with each decoded message.
     */
    onMessage?: Function | undefined;
    /**
     * - Called once the transport reaches `OPEN`.
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
     * - Histogram for heartbeat RTT. One is
     * created when omitted.
     */
    rtt?: PowerHistogram | undefined;
    /**
     * - Opt in to
     * metrics: `true` registers this helper in the shared collector, or pass a
     * collector of your own. Off by default.
     */
    observability?: boolean | import("./metrics.js").MetricsCollector | undefined;
};
import { PowerHistogram } from './powerHistogram.js';
