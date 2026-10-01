/**
 * @typedef {import('./jsdoc-types.js').PowerSocketAdapterOptions} PowerSocketAdapterOptions
 * @typedef {import('./powerWebSocketClient.js').READY_STATE} SocketReadyState
 */

/**
 * PowerSocketAdapter — one socket interface over three socket models.
 *
 * There is no WebSocket *server* in this package, and there should not be: RFC
 * 6455 is a security liability to reimplement and the `ws` package already does
 * it. What is missing is the layer that sits either side of one. A server
 * receives connections from three genuinely different objects and a naive
 * `for (ws of clients) ws.send(msg)` breaks on all of them:
 *
 * | Model | Emits on | `message` payload | Backpressure |
 * |---|---|---|---|
 * | Node `ws` | `EventEmitter` | `(data, isBinary)` | `bufferedAmount` |
 * | Browser `WebSocket` | `EventTarget` | `event.data` | `bufferedAmount` |
 * | `WebSocketStream` | `ReadableStream` | the value written | `writer.ready` |
 *
 * The differences are not cosmetic. `on('message', (data, isBinary) => ...)`
 * against an `EventTarget` socket silently never fires; `addEventListener`
 * against an `EventEmitter` socket throws; and `WebSocketStream` has neither
 * `bufferedAmount` nor `readyState`, so the "pause the producer when the socket
 * is backed up" loop that the MDN docs recommend is impossible to write against
 * it at all. This adapter is the same normalisation `WorkerAgnostic` already
 * does for `Worker` constructors, applied to sockets — plus the three things a
 * socket helper is for: **liveness**, **per-message rate limiting**, and a
 * **graceful drain**.
 *
 * @module powerSocketAdapter
 * @public
 */
import { setSafeTimeout } from '../utils/timers.js';
import { nowMs } from '../utils/now.js';
import { attach, detach } from './metrics.js';
import { assertLimitRequired } from '../utils/options.js';
import { PowerSlidingWindow } from './powerSlidingWindow.js';
import { MS_PER_SEC, READY_STATE } from './constants.js';

/**
 * The three socket models the adapter knows how to drive. Kept as a list rather
 * than three comparisons so the constructor can reject an unknown `kind` in the
 * same place it accepts a known one — an unrecognised kind used to be stored
 * as-is and then match no branch in `_attach`, which is the silent-deafness
 * failure this class exists to avoid.
 * @type {readonly ['stream', 'websocket', 'ws']}
 */
const KINDS = /** @type {const} */ (['stream', 'websocket', 'ws']);

/**
 * Retry schedule for a stream whose `readable` is not available yet.
 *
 * A `WebSocketStream` reports `readable: null` until its connection opens, and
 * the pump used to read that property once and give up — so a stream that was
 * not yet open was **permanently deaf**: `backpressureMode` reported `'streams'`,
 * `send()` worked, and not one inbound message was ever delivered.
 *
 * There is no event to wait for. `WebSocketStream` from `ws` emits `'open'`, but
 * a browser `WebSocket` exposed as a stream may not, and an object that merely
 * gains a `readable` later certainly does not, so an event-based wait would fix
 * the one case that is easy and leave the rest. Polling costs nothing when the
 * stream is already readable — the first attempt is synchronous and this is only
 * armed after that fails.
 *
 * The interval **grows**, because the failure mode of a stream that will never
 * open is a socket that polls forever. Backing off caps that at a few wakeups a
 * second indefinitely, rather than a fixed short interval at 100+/s, and it costs
 * a slow connect at most a few extra milliseconds. The timers are unref'd
 * (`setSafeTimeout`), so a waiting adapter cannot hold a Node process open.
 *
 * There is no attempt limit and no timeout: a connection that takes a minute to
 * open should still be read when it does, and `close()` and `dispose()` both stop
 * the wait. A deadline here would be a new option and a new documented failure.
 */
const STREAM_RETRY_MIN_MS = 5;
const STREAM_RETRY_MAX_MS = 250;

/**
 * The four states of a socket's lifecycle, as constants.
 *
 * Re-exported from `constants.js` rather than declared here, so it is the *same*
 * frozen object `PowerWebSocketClient` hands back. The adapter does not import
 * the client — that would pull the whole reconnect machinery into a server
 * bundle — but the constant itself costs nothing to share, and two identical-
 * looking frozen objects that fail `===` is exactly the kind of silent
 * mismatch this module exists to remove.
 */
export { READY_STATE } from './constants.js';

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
export function detectSocketKind(socket) {
  if (!socket || typeof socket !== 'object') {
    throw new TypeError('PowerSocketAdapter: socket must be an object.');
  }
  // A `WebSocketStream` is identified by its **stream methods**, not by having
  // truthy `readable`/`writable`. On a Node `Duplex` — `net.Socket` above all —
  // those two are **booleans**, so `readable && writable` matched every TCP
  // socket in existence. The adapter then read `socket.readable === true`, found
  // no `getReader`, and returned without attaching: `kind` `'stream'`, `send()`
  // `false` on every call, `isOpen` `true`, and not one inbound message
  // delivered while the socket itself was echoing them. Silent total failure,
  // reported as a healthy connection.
  //
  // `writable` is checked first because a `WebSocketStream` reports `readable:
  // null` until its connection opens, and that object is still a stream.
  if (typeof socket.writable?.getWriter === 'function') return 'stream';
  if (typeof socket.readable?.getReader === 'function') return 'stream';
  if (typeof socket.addEventListener === 'function') return 'websocket';
  // `on` alone matches every `EventEmitter` in Node — a `net.Socket`, an
  // `http.IncomingMessage` — so `send` is required as well. Without it a raw
  // TCP socket was accepted as a `ws` socket: it emits `data`, never `message`,
  // so the adapter stayed deaf, and its TCP `close` was reported as a
  // WebSocket close. An unrecognised socket is supposed to throw.
  if (typeof socket.on === 'function' && typeof socket.send === 'function') return 'ws';
  throw new TypeError(
    'PowerSocketAdapter: cannot detect the socket model. Expected a Node `ws` ' +
      'socket (EventEmitter with `send`), a browser `WebSocket` (EventTarget), or a ' +
      '`WebSocketStream` (with `getWriter`/`getReader`). A Node `Duplex` such as a ' +
      '`net.Socket` is not one of these. Pass `kind` explicitly to override detection.'
  );
}

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
  constructor(socket, options = /** @type {PowerSocketAdapterOptions} */ ({})) {
    const {
      kind,
      onMessage,
      onOpen,
      onClose,
      onError,
      onRateLimited,
      heartbeatIntervalMs = 30_000,
      heartbeatTimeoutMs = 10_000,
      idleTimeoutMs = 0,
      rateLimit = null,
      rateLimitAction = 'drop',
      drainTimeoutMs = 5_000,
    } = options || {};

    /** @type {SocketKind} */
    // `kind` short-circuits detection, and it has to. The error above tells the
    // caller to pass `kind` to override detection, and this used to call
    // `detectSocketKind` a *second* time on the following line regardless — so
    // on precisely the sockets detection rejects, the documented escape hatch
    // threw the very error it existed to bypass. A not-yet-open
    // `WebSocketStream` is the case that matters: its `readable` is `null`, it
    // has neither `on` nor `addEventListener`, and without the override there
    // was no way to construct an adapter for it at all.
    //
    // The guard that guard was replaced with could never be true: with no `kind`
    // the comparison is `x !== x`, and with a `kind` the `&& !kind` is false.
    this.kind = kind || detectSocketKind(socket);
    if (!KINDS.includes(this.kind)) {
      throw new TypeError(
        `PowerSocketAdapter: unknown kind ${JSON.stringify(this.kind)}. ` +
          `Expected one of ${KINDS.map((k) => `'${k}'`).join(', ')}.`
      );
    }
    /** @type {any} The underlying socket, for escape hatches the adapter omits. */
    this.socket = socket;

    this._onMessage = onMessage || null;
    this._onOpen = onOpen || null;
    this._onClose = onClose || null;
    this._onError = onError || null;
    this._onRateLimited = onRateLimited || null;
    this._rateLimitAction = rateLimitAction === 'close' ? 'close' : 'drop';

    this._heartbeatIntervalMs = assertLimitRequired(heartbeatIntervalMs, {
      name: 'heartbeatIntervalMs',
      className: 'PowerSocketAdapter',
      min: 0,
      fallback: 30_000,
    });
    this._heartbeatTimeoutMs = assertLimitRequired(heartbeatTimeoutMs, {
      name: 'heartbeatTimeoutMs',
      className: 'PowerSocketAdapter',
      min: 0,
      fallback: 10_000,
    });
    this._idleTimeoutMs = assertLimitRequired(idleTimeoutMs, {
      name: 'idleTimeoutMs',
      className: 'PowerSocketAdapter',
      min: 0,
      fallback: 0,
    });
    this._drainTimeoutMs = assertLimitRequired(drainTimeoutMs, {
      name: 'drainTimeoutMs',
      className: 'PowerSocketAdapter',
      min: 0,
      fallback: 5_000,
    });

    /** @type {PowerSlidingWindow|null} */
    this._limiter = null;
    if (rateLimit) {
      const { limit = 100, windowMs = MS_PER_SEC } = rateLimit;
      this._limiter = new PowerSlidingWindow({ capacity: limit, windowMs });
    }

    this._state =
      this.kind === 'stream' ? READY_STATE.OPEN : (socket.readyState ?? READY_STATE.OPEN);
    this._draining = false;
    this._disposed = false;
    this._closedByUser = false;
    this._detached = null;
    /** @type {?ReturnType<typeof setTimeout>} */
    this._heartbeatTimer = null;
    /** @type {?ReturnType<typeof setTimeout>} */
    this._heartbeatDeadline = null;
    /** @type {?ReturnType<typeof setTimeout>} */
    this._idleTimer = null;
    /** @type {?ReturnType<typeof setTimeout>} */
    this._drainTimer = null;
    this._lastActivityAt = nowMs();
    this._pingSentAt = 0;
    this._pending = 0;
    /** @type {Array<(ok: boolean) => void>} */
    this._drainWaiters = [];
    /** @type {?Promise<boolean>} */
    this._drainPromise = null;
    /**
     * The single `WebSocketStream` writer, acquired on first send and held
     * until dispose. See `_writeStream` for why it cannot be per-call.
     * @type {any}
     */
    this._streamWriter = null;
    this._streamWritePending = 0;
    /** @type {any} Timer for re-arming the stream pump. See `STREAM_RETRY_MIN_MS`. */
    this._streamRetryTimer = null;
    /** @type {number} Current retry delay, so the backoff actually grows. */
    this._streamRetryDelay = STREAM_RETRY_MIN_MS;

    this._counters = {
      messages: 0,
      handled: 0,
      rateLimited: 0,
      sent: 0,
      sendFailures: 0,
      backpressureEvents: 0,
      heartbeatTimeouts: 0,
      idleTimeouts: 0,
      drained: 0,
      drainTimeouts: 0,
      drainedFromDrain: 0,
    };

    this._attach();
    this._resetIdleTimer();
    this._scheduleHeartbeat();
    // FEAT-007: opt-in metrics. Off by default, so the common case pays nothing and allocates no closure.
    this._metrics = attach(this, 'socket', options);
  }

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
  get readyState() {
    return this._state;
  }

  /**
   * Whether the socket is open and not draining.
   * @returns {boolean}
   */
  get isOpen() {
    return this._state === READY_STATE.OPEN && !this._draining;
  }

  /**
   * Whether {@link PowerSocketAdapter#drain} has been called.
   * @returns {boolean}
   */
  get isDraining() {
    return this._draining;
  }

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
  get bufferedAmount() {
    if (this.kind === 'stream') return 0;
    const n = Number(this.socket?.bufferedAmount);
    return Number.isFinite(n) ? n : 0;
  }

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
  get canPing() {
    return this.kind === 'ws' && typeof this.socket?.ping === 'function';
  }

  /**
   * Send data over the socket.
   *
   * @param {string|ArrayBuffer|ArrayBufferView} data
   * @returns {boolean} `false` when the socket is not open, is draining, or is
   *   disposed. Never throws for an ordinary "cannot send right now" — a send
   *   loop that has to try/catch every call is a send loop that will eventually
   *   swallow a real error.
   */
  send(data) {
    if (this._disposed || this._draining) return false;
    if (this._state !== READY_STATE.OPEN) return false;
    try {
      if (this.kind === 'stream') return this._writeStream(data);
      this.socket.send(data);
      this._counters.sent += 1;
      return true;
    } catch (e) {
      this._counters.sendFailures += 1;
      this._emitError(e);
      return false;
    }
  }

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
  _writeStream(data) {
    if (!this._streamWriter) {
      this._streamWriter = this.socket.writable?.getWriter?.() || null;
    }
    const writer = this._streamWriter;
    if (!writer) return false;
    // A stream's real backpressure signal is `writer.ready`, which is only
    // awaitable. Rather than fire and forget, an already-saturated writer is
    // reported as a refusal so the caller can await `drain()` and retry - the
    // documented contract for `send()` is "false means not now".
    if (writer.desiredSize != null && writer.desiredSize <= 0 && this._streamWritePending > 0) {
      this._counters.backpressureEvents += 1;
      return false;
    }
    this._streamWritePending += 1;
    this._pending += 1;
    const settle = () => {
      this._streamWritePending -= 1;
      this._pending -= 1;
      this._flushDrainWaiters();
    };
    Promise.resolve(writer.write(data)).then(settle, (e) => {
      settle();
      this._counters.sendFailures += 1;
      this._emitError(e);
    });
    this._counters.sent += 1;
    return true;
  }

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
  close(code = 1000, reason = '') {
    if (this._disposed) return;
    this._closedByUser = true;
    this._clearTimers();
    try {
      if (this.kind === 'stream') {
        // A stream has no `close(code, reason)`, so the code is recorded and
        // the socket is released by closing the writer's side.
        this.socket.close?.(code, reason);
      } else if (this._state !== READY_STATE.CLOSED && this._state !== READY_STATE.CLOSING) {
        this.socket.close(code, reason);
      }
    } catch (e) {
      this._emitError(e);
    }
    this._state = READY_STATE.CLOSED;
    this._finishDrain();
    // `close()` sets the state itself rather than routing through
    // `_handleClose`, so it needs the same lock release — otherwise the local
    // close path leaked the writer exactly as the remote one did, and this is
    // the path a caller reaches first.
    this._releaseStreamWriter();
  }

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
  drain(code = 1000, reason = '') {
    if (this._draining && this._drainPromise) return this._drainPromise;
    this._draining = true;
    this._drainPromise = new Promise((resolve) => {
      const finish = (/** @type {boolean} */ ok) => {
        this._counters.drained += 1;
        this._finishDrain();
        this.close(code, reason);
        resolve(ok);
      };
      this._drainWaiters.push(finish);
      this._flushDrainWaiters();
      if (this._pending === 0) {
        finish(true);
        return;
      }
      if (this._drainTimeoutMs > 0) {
        this._drainTimer = setSafeTimeout(() => {
          this._drainTimer = null;
          // Timed out: close anyway. Waiting forever is how a deploy hangs.
          this._counters.drainTimeouts += 1;
          finish(false);
        }, this._drainTimeoutMs);
      }
    });
    return this._drainPromise;
  }

  /**
   * Counters, plus the liveness mode actually in use.
   *
   * @returns {object}
   */
  stats() {
    return {
      ...this._counters,
      kind: this.kind,
      state: this._state,
      canPing: this.canPing,
      pending: this._pending,
      bufferedAmount: this.bufferedAmount,
      lastActivityAt: this._lastActivityAt,
    };
  }

  /**
   * Detach every listener and cancel every timer.
   *
   * Required rather than tidy: a `ws` socket outliving its adapter keeps the
   * adapter's closures alive, and a server that never disposes on disconnect
   * leaks one adapter per connection for the life of the process.
   *
   * @returns {void}
   */
  dispose() {
    detach(this._metrics);
    this._metrics = null;
    if (this._disposed) return;
    this._disposed = true;
    this._clearTimers();
    this._detach();
    this._state = READY_STATE.CLOSED;
    // Held so `using` works, matching the rest of the library.
    this._onMessage = null;
    this._onOpen = null;
    this._onClose = null;
    this._onError = null;
    this._onRateLimited = null;
    this._drainWaiters.length = 0;
    this.socket = null;
  }

  /**
   * Alias for {@link PowerSocketAdapter#dispose}, so `using` works.
   */
  [Symbol.dispose]() {
    this.dispose();
  }

  /**
   * @private
   */
  _attach() {
    if (this.kind === 'stream') {
      this._attachStream();
      return;
    }
    if (this.kind === 'websocket') {
      const onMessage = (/** @type {any} */ e) => this._handleMessage(e.data, false);
      const onOpen = () => {
        this._state = READY_STATE.OPEN;
        this._resetIdleTimer();
        this._invoke(this._onOpen, this);
      };
      const onClose = (/** @type {any} */ e) => this._handleClose(e?.code ?? 1006, e?.reason ?? '');
      const onError = (/** @type {any} */ e) => this._emitError(e);
      this.socket.addEventListener('message', onMessage);
      this.socket.addEventListener('open', onOpen);
      this.socket.addEventListener('close', onClose);
      this.socket.addEventListener('error', onError);
      this._detached = () => {
        this.socket?.removeEventListener?.('message', onMessage);
        this.socket?.removeEventListener?.('open', onOpen);
        this.socket?.removeEventListener?.('close', onClose);
        this.socket?.removeEventListener?.('error', onError);
      };
      return;
    }
    // Node `ws`: `message` carries `(data, isBinary)`, which is the detail that
    // makes the two models incompatible - an `EventTarget` handler receives
    // one event object, not a data/isBinary pair.
    const onMessage = (/** @type {any} */ data, /** @type {any} */ isBinary) =>
      this._handleMessage(data, Boolean(isBinary));
    const onOpen = () => {
      this._state = READY_STATE.OPEN;
      this._resetIdleTimer();
      this._invoke(this._onOpen, this);
    };
    const onClose = (/** @type {any} */ code, /** @type {any} */ reason) =>
      this._handleClose(code ?? 1006, reason?.toString?.() ?? '');
    const onError = (/** @type {any} */ e) => this._emitError(e);
    // `ws` emits `pong` when a pong *arrives* and `ping` when a ping arrives, so
    // it is `pong` that answers our liveness probe. Listening for `ping` instead
    // would never fire on a server, whose sockets receive pings from every
    // client and send pongs - the mirror image, and it would make every socket
    // look dead the moment one client pinged.
    const onPong = () => this._handlePong();
    this.socket.on('message', onMessage);
    this.socket.on('open', onOpen);
    this.socket.on('close', onClose);
    this.socket.on('error', onError);
    this.socket.on('pong', onPong);
    this._detached = () => {
      const s = this.socket;
      if (!s || typeof s.off !== 'function') return;
      s.off('message', onMessage);
      s.off('open', onOpen);
      s.off('close', onClose);
      s.off('error', onError);
      s.off('pong', onPong);
    };
  }

  /**
   * `WebSocketStream` emits on a `ReadableStream` rather than on an emitter,
   * so it is read with a reader and the loop is restarted on each value.
   * @private
   */
  _attachStream() {
    this._streamReader = null;
    this._pumpStream = async () => {
      const readable = this.socket?.readable;
      if (!readable || typeof readable.getReader !== 'function') {
        // A `WebSocketStream` is not readable until it has connected. Returning
        // here left the adapter reporting `'streams'` with a working `send()`
        // and no way to ever receive anything, so this now waits — see
        // `STREAM_RETRY_MIN_MS` for why polling rather than an event.
        this._armStreamRetry();
        return;
      }
      this._streamReader = readable.getReader();
      // Armed and no longer needed. Resetting the backoff means a *second*
      // wait, after a reconnect, starts fast again.
      this._streamRetryDelay = STREAM_RETRY_MIN_MS;
      try {
        for (;;) {
          const { value, done } = await this._streamReader.read();
          if (done) break;
          this._handleMessage(value, typeof value !== 'string');
        }
      } catch (/** @type {any} */ e) {
        // An aborted or errored read is how a closed stream reports itself.
        // Not an adapter fault, so it is routed to `onClose` rather than
        // `onError`.
        this._handleClose(1006, e?.message ?? '');
        return;
      }
      this._handleClose(1000, '');
    };
    this._streamPromise = this._pumpStream();
  }

  /**
   * Re-check `socket.readable` after a growing delay.
   *
   * A no-op once the reader is attached, and once the adapter is closed or
   * disposed, so a waiting adapter stops as soon as it is no longer wanted.
   *
   * @private
   */
  _armStreamRetry() {
    if (this._streamReader) return;
    if (this._disposed || this._state === READY_STATE.CLOSED) return;
    if (this._streamRetryTimer) return;
    this._streamRetryTimer = setSafeTimeout(() => {
      this._streamRetryTimer = null;
      // Optional call, not a bare one: `_pumpStream` is installed as a property
      // by `_attachStream` rather than declared as a field, so the checker is
      // right that it may be absent — and a retry cannot fire before the attach
      // that armed it. `typecheck:ratchet` caught this at 291 against a 290
      // ceiling, which is the ratchet doing the one job it exists for.
      this._pumpStream?.();
    }, this._streamRetryDelay);
    this._streamRetryDelay = Math.min(this._streamRetryDelay * 2, STREAM_RETRY_MAX_MS);
  }

  /**
   * @private
   */
  _handleMessage(/** @type {any} */ data, /** @type {any} */ isBinary) {
    this._lastActivityAt = nowMs();
    this._resetIdleTimer();
    this._handlePong();
    this._counters.messages += 1;
    if (this._draining) {
      // Counting a dropped message is the whole point of a drain: the number
      // is what tells you whether the timeout was generous enough.
      this._counters.drainedFromDrain += 1;
      return;
    }
    if (this._limiter && !this._limiter.tryConsume()) {
      this._counters.rateLimited += 1;
      this._invoke(this._onRateLimited, this._counters.rateLimited);
      if (this._rateLimitAction === 'close') {
        this.close(1008, 'rate limit');
      }
      return;
    }
    if (!this._onMessage) return;
    // Counted separately from `messages`, which is every frame that arrived.
    // Without a distinct "actually delivered" figure, `stats()` cannot answer
    // the question it exists to answer - what fraction of inbound traffic your
    // application really processed - because `messages` includes everything the
    // rate limiter refused.
    this._counters.handled += 1;
    this._pending += 1;
    let result;
    try {
      result = this._onMessage({ data, isBinary, adapter: this });
    } catch (e) {
      this._pending -= 1;
      this._flushDrainWaiters();
      this._emitError(e);
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then(
        () => {
          this._pending -= 1;
          this._flushDrainWaiters();
        },
        (e) => {
          this._pending -= 1;
          this._flushDrainWaiters();
          this._emitError(e);
        }
      );
    } else {
      this._pending -= 1;
      this._flushDrainWaiters();
    }
  }

  /**
   * @private
   */
  _handleClose(/** @type {any} */ code, /** @type {any} */ reason) {
    if (this._state === READY_STATE.CLOSED) return;
    this._state = READY_STATE.CLOSED;
    this._clearTimers();
    this._finishDrain();
    // The adapter's own comment on `_writeStream` calls a permanently locked
    // stream permanent damage, but the lock was only ever released by
    // `_detach`, which runs on `dispose()`. A socket that closes — and
    // `close()` is one of the adapter's own methods — left `writable` locked
    // for good, so a caller holding the socket could not write to it again even
    // after reconnecting a new stream over it.
    this._releaseStreamWriter();
    this._invoke(this._onClose, { code, reason, adapter: this });
  }

  /**
   * Hand back the writer lock taken in `_writeStream`, if one is held.
   *
   * Called from both `_handleClose` and `_detach`, and idempotent: the second
   * call finds `_streamWriter` already null.
   *
   * @private
   */
  _releaseStreamWriter() {
    if (!this._streamWriter) return;
    // Without this the stream stays locked for the life of the stream object,
    // so nothing else could ever write to it - including a caller that got the
    // socket back.
    try {
      this._streamWriter.releaseLock?.();
    } catch (e) {
      /* a writer with an in-flight write cannot be released; the stream is closing */
    }
    this._streamWriter = null;
  }

  /**
   * @private
   */
  _handlePong() {
    if (this._heartbeatDeadline) {
      clearTimeout(this._heartbeatDeadline);
      this._heartbeatDeadline = null;
    }
  }

  /**
   * @private
   */
  _scheduleHeartbeat() {
    if (this._disposed || this._heartbeatIntervalMs <= 0) return;
    this._heartbeatTimer = setSafeTimeout(() => {
      this._heartbeatTimer = null;
      this._tickHeartbeat();
      if (this._state === READY_STATE.OPEN) this._scheduleHeartbeat();
    }, this._heartbeatIntervalMs);
  }

  /**
   * @private
   */
  _tickHeartbeat() {
    if (!this.canPing) {
      // No protocol-level ping available - the browser deliberately does not
      // expose one, and `WebSocketStream` has none. The adapter does not
      // pretend otherwise; `stats().canPing` reports `false` and the liveness
      // signal is message activity plus the idle timer, if configured.
      return;
    }
    this._pingSentAt = nowMs();
    try {
      this.socket.ping();
    } catch (e) {
      this._emitError(e);
      return;
    }
    // Arm the deadline **once per live window**, and never while one is already
    // outstanding. Two things were wrong here and the row's prescription only
    // addresses the first.
    //
    // The handle was overwritten without being cleared, so a socket that never
    // answered orphaned one timer per tick - none clearable, each firing later to
    // increment `heartbeatTimeouts` and close the socket. Measured with a socket
    // whose `ping()` is never answered: three ticks, three deadlines armed, zero
    // cleared.
    //
    // But *clearing and re-arming* is worse than either: the deadline measures
    // from the ping, so resetting it on every tick means a socket that never
    // answers never times out at all whenever `heartbeatTimeoutMs` exceeds
    // `heartbeatIntervalMs`. Two existing tests caught that, and they are right -
    // the fix is to leave a live deadline alone.
    if (this._heartbeatTimeoutMs > 0 && !this._heartbeatDeadline) {
      // Clear the previous deadline before arming the next one. It was cleared only in
      // `_handlePong`/`_onPong`, so a socket that never answers re-armed here on every
      // tick and **overwrote** the handle: one orphan timer per tick, none of them
      // clearable, and each firing later to increment `heartbeatTimeouts` and close the
      // socket. Measured with a socket whose `ping()` is never answered, three ticks:
      // three deadlines armed, zero cleared.
      //
      // The clean-up is idempotent - the handle is nulled on both the clear and the
      // fire - so a pong landing mid-window clears nothing twice.

      this._heartbeatDeadline = setSafeTimeout(() => {
        this._heartbeatDeadline = null;
        this._counters.heartbeatTimeouts += 1;
        this._clearTimers();
        // A socket can sit in OPEN forever with nothing getting through - the
        // normal state of affairs behind a dead load balancer. Treating that
        // as alive is how a "connected" pool serves 100 % errors.
        try {
          this.socket?.close(4000, 'heartbeat timeout');
        } catch (e) {
          this._emitError(e);
        }
        this._state = READY_STATE.CLOSED;
        this._finishDrain();
        this._invoke(this._onClose, { code: 4000, reason: 'heartbeat timeout', adapter: this });
      }, this._heartbeatTimeoutMs);
    }
  }

  /**
   * @private
   */
  _resetIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    if (this._disposed || this._idleTimeoutMs <= 0) return;
    this._idleTimer = setSafeTimeout(() => {
      this._idleTimer = null;
      this._counters.idleTimeouts += 1;
      this._clearTimers();
      try {
        this.socket?.close(1001, 'idle timeout');
      } catch (e) {
        this._emitError(e);
      }
      this._state = READY_STATE.CLOSED;
      this._finishDrain();
      this._invoke(this._onClose, { code: 1001, reason: 'idle timeout', adapter: this });
    }, this._idleTimeoutMs);
  }

  /**
   * @private
   */
  _flushDrainWaiters() {
    if (this._pending > 0 || this._drainWaiters.length === 0) return;
    const waiters = this._drainWaiters;
    this._drainWaiters = [];
    for (const resolve of waiters) resolve(true);
  }

  /**
   * @private
   */
  _finishDrain() {
    if (this._drainTimer) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
    }
    if (this._drainWaiters.length === 0) return;
    const waiters = this._drainWaiters;
    this._drainWaiters = [];
    for (const resolve of waiters) resolve(this._pending === 0);
  }

  /**
   * @private
   */
  _clearTimers() {
    if (this._heartbeatTimer) {
      clearTimeout(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._heartbeatDeadline) {
      clearTimeout(this._heartbeatDeadline);
      this._heartbeatDeadline = null;
    }
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    if (this._drainTimer) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
    }
    // A pending stream retry is a timer like any other, and it is the one that
    // would otherwise outlive a close: nothing else re-arms it, so it would sit
    // re-checking `readable` on a socket the adapter has finished with.
    if (this._streamRetryTimer) {
      clearTimeout(this._streamRetryTimer);
      this._streamRetryTimer = null;
    }
  }

  /**
   * @private
   */
  _detach() {
    if (typeof this._detached === 'function') {
      try {
        this._detached();
      } catch (e) {
        /* a socket that refuses to detach must not block disposal */
      }
    }
    this._detached = null;
    if (this._streamReader) {
      try {
        this._streamReader.cancel();
      } catch (e) {
        /* the stream may already be closed */
      }
      this._streamReader = null;
    }
    if (this._streamWriter) {
      this._releaseStreamWriter();
    }
  }

  /**
   * @private
   */
  _emitError(/** @type {any} */ err) {
    if (typeof this._onError === 'function') {
      try {
        this._onError(err, this);
      } catch (e) {
        /* a throwing error handler must not become an unhandled rejection */
      }
    }
  }

  /**
   * @private
   */
  _invoke(/** @type {any} */ fn, /** @type {any} */ arg) {
    if (typeof fn !== 'function') return;
    try {
      fn(arg);
    } catch (e) {
      this._emitError(e);
    }
  }
}

export default PowerSocketAdapter;
