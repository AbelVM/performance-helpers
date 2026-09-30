/**
 * The transport family a socket was detected as.
 *
 * @typedef {'ws'|'websocket'|'stream'} SocketKind
 */
/**
 * What to do with a message that exceeds the rate limit.
 *
 * `drop` is the default and the right one for an *inbound* limit: a client
 * sending faster than you can process is a client you cannot serve, and
 * silently discarding its excess keeps your own work bounded. `close` is for
 * the case where the traffic is abusive rather than merely fast.
 *
 * @typedef {'drop'|'close'} RateLimitAction
 */
/**
 * Detect which socket model this is.
 *
 * Probed by capability rather than by constructor name, because the same class
 * is reachable under several: `ws` in Node, `undici`'s `WebSocket` in newer
 * Node, and the global in a browser, and the last two are genuinely different
 * objects that happen to share a name.
 *
 * The order matters and is not arbitrary. `WebSocketStream` is checked first
 * because a `WebSocketStream` exposes `readable`/`writable` but is otherwise
 * unremarkable — testing for `on` or `addEventListener` first would fall
 * through to a default rather than detect it.
 *
 * @param {any} socket
 * @returns {SocketKind}
 * @private
 */
export function detectSocketKind(socket: any): SocketKind;
export { READY_STATE } from "./constants.js";
/**
 * PowerSocketAdapter
 *
 * @class PowerSocketAdapter
 * @public
 * @example
 * // Node `ws` server side.
 * const adapter = new PowerSocketAdapter(ws, {
 *   heartbeatIntervalMs: 30_000,
 *   onMessage: (msg) => handle(msg.data),
 *   rateLimit: { limit: 100, windowMs: 1_000 },
 * });
 * server.on('connection', (ws) => new PowerSocketAdapter(ws, handlers));
 */
export class PowerSocketAdapter {
    /**
     * @param {any} socket - A Node `ws` socket, a browser `WebSocket`, or a
     *   `WebSocketStream`.
     * @param {PowerSocketAdapterOptions} [options]
     */
    constructor(socket: any, options?: PowerSocketAdapterOptions);
    /** @type {SocketKind} */
    kind: SocketKind;
    /** @type {any} The underlying socket, for escape hatches the adapter omits. */
    socket: any;
    _onMessage: ((arg0: import("./jsdoc-types.js").PowerSocketAdapterMessage) => (void | Promise<void>)) | null;
    _onOpen: ((arg0: import("./powerSocketAdapter.js").PowerSocketAdapter) => void) | null;
    _onClose: ((arg0: {
        code: number;
        reason: string;
        adapter: import("./powerSocketAdapter.js").PowerSocketAdapter;
    }) => void) | null;
    _onError: ((arg0: any, arg1: import("./powerSocketAdapter.js").PowerSocketAdapter) => void) | null;
    _onRateLimited: import("./jsdoc-types.js").PowerSocketAdapterRateLimited | null;
    _rateLimitAction: string;
    _heartbeatIntervalMs: number;
    _heartbeatTimeoutMs: number;
    _idleTimeoutMs: number;
    _drainTimeoutMs: number;
    /** @type {PowerSlidingWindow|null} */
    _limiter: PowerSlidingWindow | null;
    _state: any;
    _draining: boolean;
    _disposed: boolean;
    _closedByUser: boolean;
    _detached: (() => void) | (() => void) | null;
    /** @type {?ReturnType<typeof setTimeout>} */
    _heartbeatTimer: ReturnType<typeof setTimeout> | null;
    /** @type {?ReturnType<typeof setTimeout>} */
    _heartbeatDeadline: ReturnType<typeof setTimeout> | null;
    /** @type {?ReturnType<typeof setTimeout>} */
    _idleTimer: ReturnType<typeof setTimeout> | null;
    /** @type {?ReturnType<typeof setTimeout>} */
    _drainTimer: ReturnType<typeof setTimeout> | null;
    _lastActivityAt: number;
    _pingSentAt: number;
    _pending: number;
    /** @type {Array<(ok: boolean) => void>} */
    _drainWaiters: Array<(ok: boolean) => void>;
    /** @type {?Promise<boolean>} */
    _drainPromise: Promise<boolean> | null;
    /**
     * The single `WebSocketStream` writer, acquired on first send and held
     * until dispose. See `_writeStream` for why it cannot be per-call.
     * @type {any}
     */
    _streamWriter: any;
    _streamWritePending: number;
    _counters: {
        messages: number;
        handled: number;
        rateLimited: number;
        sent: number;
        sendFailures: number;
        backpressureEvents: number;
        heartbeatTimeouts: number;
        idleTimeouts: number;
        drained: number;
        drainTimeouts: number;
        drainedFromDrain: number;
    };
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
    /**
     * The socket's lifecycle state, as a `READY_STATE` constant.
     *
     * A `WebSocketStream` has no `readyState` at all, so it reports `OPEN` for
     * its whole life and `CLOSED` after {@link PowerSocketAdapter#close}. This is
     * a real difference in fidelity, not a normalisation that loses information:
     * a stream's liveness is observable through its reader, not its state.
     *
     * @returns {number}
     */
    get readyState(): number;
    /**
     * Whether the socket is open and not draining.
     * @returns {boolean}
     */
    get isOpen(): boolean;
    /**
     * Whether {@link PowerSocketAdapter#drain} has been called.
     * @returns {boolean}
     */
    get isDraining(): boolean;
    /**
     * Bytes buffered by the transport, for the `bufferedAmount` watermark.
     *
     * Always `0` for a `WebSocketStream`, which has no `bufferedAmount` because
     * it provides real backpressure through `writer.ready` instead. Reporting 0
     * rather than `NaN` or `Infinity` is deliberate: a caller polling a watermark
     * would treat those as "never backed up" and never pause.
     *
     * @returns {number}
     */
    get bufferedAmount(): number;
    /**
     * Whether the transport exposes a usable `ping()`.
     *
     * Node `ws` does; browsers do not, because the API is deliberately not
     * exposed to script. `WebSocketStream` does not either. When this is `false`
     * the adapter cannot run a protocol-level heartbeat, and the liveness signal
     * it falls back to is message activity — see
     * {@link PowerSocketAdapter#stats}.
     *
     * @returns {boolean}
     */
    get canPing(): boolean;
    /**
     * Send data over the socket.
     *
     * @param {string|ArrayBuffer|ArrayBufferView} data
     * @returns {boolean} `false` when the socket is not open, is draining, or is
     *   disposed. Never throws for an ordinary "cannot send right now" — a send
     *   loop that has to try/catch every call is a send loop that will eventually
     *   swallow a real error.
     */
    send(data: string | ArrayBuffer | ArrayBufferView): boolean;
    /**
     * Write to a `WebSocketStream`.
     *
     * The writer is acquired **once** and held for the adapter's lifetime, then
     * released on `dispose()`. Taking a fresh `getWriter()` per `send()` looks
     * harmless and is not: `getWriter()` locks the stream, and the lock is only
     * released by `releaseLock()`. So the second `send()` on a stream adapter
     * would throw `TypeError: ReadableStream is locked` — and the first
     * `dispose()` would be the only thing that ever unlocked it.
     *
     * `send()` stays synchronous and returns a boolean, so it is a drop-in for
     * the `ws` path. The write promise is tracked so {@link
     * PowerSocketAdapter#drain} can wait for it: an un-awaited `write()` that
     * later rejects is an unhandled rejection, and a drain that returned before
     * it settled would close the stream mid-write.
     *
     * @private
     * @param {any} data
     * @returns {boolean}
     */
    private _writeStream;
    /**
     * Close the socket.
     *
     * Safe to call more than once, and on a socket in any state — the underlying
     * `ws` throws on a double close in some versions, which is exactly the kind
     * of thing a shutdown path should not have to know.
     *
     * @param {number} [code=1000] - Close code.
     * @param {string} [reason=''] - Close reason.
     * @returns {void}
     */
    close(code?: number, reason?: string): void;
    /**
     * Stop accepting work, let what is in flight finish, then close.
     *
     * This is the difference between a deploy that drops a thousand in-flight
     * requests and one that does not. The sequence is:
     *
     * 1. `isOpen` becomes `false` and `send()` refuses, so a producer stops
     *    immediately rather than queueing into a socket that is about to close.
     * 2. In-flight `onMessage` handlers are allowed to settle.
     * 3. The socket is closed, and the promise resolves.
     *
     * Step 3 is bounded by `drainTimeoutMs`, because a handler that never settles
     * would otherwise hold a deploy open forever. A drain that times out reports
     * `drainTimeouts` in {@link PowerSocketAdapter#stats} rather than pretending
     * it finished cleanly.
     *
     * @param {number} [code=1000] - Close code.
     * @param {string} [reason=''] - Close reason.
     * @returns {Promise<boolean>} `true` when everything settled in time, `false`
     *   on timeout.
     */
    drain(code?: number, reason?: string): Promise<boolean>;
    /**
     * Counters, plus the liveness mode actually in use.
     *
     * @returns {object}
     */
    stats(): object;
    /**
     * Detach every listener and cancel every timer.
     *
     * Required rather than tidy: a `ws` socket outliving its adapter keeps the
     * adapter's closures alive, and a server that never disposes on disconnect
     * leaks one adapter per connection for the life of the process.
     *
     * @returns {void}
     */
    dispose(): void;
    /**
     * @private
     */
    private _attach;
    /**
     * `WebSocketStream` emits on a `ReadableStream` rather than on an emitter,
     * so it is read with a reader and the loop is restarted on each value.
     * @private
     */
    private _attachStream;
    _streamReader: any;
    _pumpStream: (() => Promise<void>) | undefined;
    _streamPromise: Promise<void> | undefined;
    /**
     * @private
     */
    private _handleMessage;
    /**
     * @private
     */
    private _handleClose;
    /**
     * Hand back the writer lock taken in `_writeStream`, if one is held.
     *
     * Called from both `_handleClose` and `_detach`, and idempotent: the second
     * call finds `_streamWriter` already null.
     *
     * @private
     */
    private _releaseStreamWriter;
    /**
     * @private
     */
    private _handlePong;
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
    private _resetIdleTimer;
    /**
     * @private
     */
    private _flushDrainWaiters;
    /**
     * @private
     */
    private _finishDrain;
    /**
     * @private
     */
    private _clearTimers;
    /**
     * @private
     */
    private _detach;
    /**
     * @private
     */
    private _emitError;
    /**
     * @private
     */
    private _invoke;
    /**
     * Alias for {@link PowerSocketAdapter#dispose}, so `using` works.
     */
    [Symbol.dispose](): void;
}
export default PowerSocketAdapter;
/**
 * The transport family a socket was detected as.
 */
export type SocketKind = "ws" | "websocket" | "stream";
/**
 * What to do with a message that exceeds the rate limit.
 *
 * `drop` is the default and the right one for an *inbound* limit: a client
 * sending faster than you can process is a client you cannot serve, and
 * silently discarding its excess keeps your own work bounded. `close` is for
 * the case where the traffic is abusive rather than merely fast.
 */
export type RateLimitAction = "drop" | "close";
export type PowerSocketAdapterOptions = import("./jsdoc-types.js").PowerSocketAdapterOptions;
export type SocketReadyState = any;
import { PowerSlidingWindow } from './powerSlidingWindow.js';
