/**
 * WebSocket client with back-pressure, heartbeats and reconnection.
 *
 * ## The problem this exists for
 *
 * The `WebSocket` interface has **no back-pressure**. As MDN puts it: "The
 * `WebSocket` interface ... doesn't support back-pressure. As a result, when
 * messages arrive faster than the application can process them it will either
 * fill up the device's memory by buffering those messages, become unresponsive
 * due to 100 % CPU usage, or both."
 *
 * A producer that ignores this will OOM the client, and — on a server that
 * fans out to many sockets — OOM the server too. Two mitigations exist, and this
 * client uses whichever is available:
 *
 * 1. **`bufferedAmount` watermarks** (universal). `send()` returns immediately
 *    and the browser buffers internally, so the producer must watch
 *    `socket.bufferedAmount` and stop feeding it above a high-water mark. MDN's
 *    own advice is to poll, which is exactly what this does — but on a timer
 *    that backs off rather than a tight loop, and it exposes `pause()`/`resume()`
 *    events so a producer can be driven by it instead of polling.
 * 2. **Streams** (where `WebSocketStream` exists). It is a Promise-based
 *    alternative built on the Streams API and therefore "can take advantage of
 *    stream back-pressure automatically". It is not yet standard or
 *    universally available, so it is feature-detected and the watermark tier is
 *    always kept as the fallback.
 *
 * ## On the wire
 *
 * Frames are encoded and decoded with {@link PowerMessageCodec}, so this pairs
 * directly with {@link PowerRealtimeHub} — pass {@link PowerWebSocketClient#send}
 * as the hub's `send` adapter and a slow socket is handled at both layers: the
 * watermark stops the producer here, the bounded queue handles it there.
 *
 * @module powerWebSocketClient
 * @public
 */
import { decodeMessage, encodeMessage } from './powerMessageCodec.js';
import { PowerHistogram } from './powerHistogram.js';
import { setSafeTimeout } from '../utils/timers.js';
import { nowMs } from '../utils/now.js';

/** @typedef {'connecting'|'open'|'closing'|'closed'} WebSocketReadyState */

/** The four states of a socket's lifecycle, as constants. */
export const READY_STATE = Object.freeze({
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
});

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
  /**
   * @param {WebSocketClientOptions} options
   */
  constructor(options = {}) {
    const {
      url,
      WebSocketImpl,
      WebSocketStreamImpl,
      codec = 'json',
      connectTimeoutMs = 10_000,
      highWaterMarkBytes = 1 << 20,
      lowWaterMarkBytes = 1 << 19,
      pollIntervalMs = 20,
      maxPollIntervalMs = 250,
      heartbeatIntervalMs = 30_000,
      heartbeatTimeoutMs = 10_000,
      maxReconnectAttempts = Number.POSITIVE_INFINITY,
      reconnectBaseMs = 500,
      reconnectMaxMs = 30_000,
      autoReconnect = true,
      reconnectOnHeartbeatTimeout = true,
      onMessage,
      onOpen,
      onClose,
      onError,
      onPause,
      onResume,
      rtt,
      protocols,
    } = options || {};

    if (typeof url !== 'string' || url === '') {
      throw new TypeError('PowerWebSocketClient: `url` must be a non-empty string');
    }
    if (codec !== 'json' && codec !== 'raw') {
      throw new TypeError("PowerWebSocketClient: `codec` must be 'json' or 'raw'");
    }
    if (lowWaterMarkBytes > highWaterMarkBytes) {
      throw new TypeError(
        'PowerWebSocketClient: `lowWaterMarkBytes` must be <= `highWaterMarkBytes` ' +
          '(otherwise the socket would pause and never resume)'
      );
    }

    this.url = url;
    this.protocols = protocols;
    this._WS = WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!this._WS) {
      throw new TypeError(
        'PowerWebSocketClient: no WebSocket implementation found. Pass `WebSocketImpl`.'
      );
    }
    this._WSStream =
      WebSocketStreamImpl || (typeof WebSocketStream !== 'undefined' ? WebSocketStream : null);
    this._codec = codec;
    this._connectTimeoutMs = Math.max(0, Math.floor(Number(connectTimeoutMs) || 0));
    this._highWaterMark = Math.max(0, Number(highWaterMarkBytes) || 0);
    this._lowWaterMark = Math.max(0, Number(lowWaterMarkBytes) || 0);
    this._pollBase = Math.max(1, Math.floor(Number(pollIntervalMs) || 20));
    this._pollMax = Math.max(this._pollBase, Math.floor(Number(maxPollIntervalMs) || 250));
    this._heartbeatIntervalMs = Math.max(0, Math.floor(Number(heartbeatIntervalMs) || 0));
    this._heartbeatTimeoutMs = Math.max(0, Math.floor(Number(heartbeatTimeoutMs) || 0));
    this._maxReconnectAttempts = maxReconnectAttempts;
    this._reconnectBaseMs = Math.max(1, Math.floor(Number(reconnectBaseMs) || 500));
    this._reconnectMaxMs = Math.max(
      this._reconnectBaseMs,
      Math.floor(Number(reconnectMaxMs) || 30_000)
    );
    this._autoReconnect = autoReconnect !== false;
    this._reconnectOnHeartbeatTimeout = reconnectOnHeartbeatTimeout !== false;

    this._on = {
      message: typeof onMessage === 'function' ? onMessage : null,
      open: typeof onOpen === 'function' ? onOpen : null,
      close: typeof onClose === 'function' ? onClose : null,
      error: typeof onError === 'function' ? onError : null,
      pause: typeof onPause === 'function' ? onPause : null,
      resume: typeof onResume === 'function' ? onResume : null,
    };

    this._socket = null;
    /** @type {WritableStreamDefaultWriter|null} */
    this._writer = null;
    this._state = READY_STATE.CLOSED;
    this._closedByUser = false;
    this._reconnectAttempts = 0;
    this._connectTimer = null;
    this._pollTimer = null;
    this._heartbeatTimer = null;
    this._heartbeatDeadline = null;
    this._reconnectTimer = null;
    this._paused = false;
    this._lastPollInterval = this._pollBase;
    this._lastPongAt = 0;
    this._pingSentAt = 0;
    /** decorrelated-jitter backoff cursor, in ms */
    this._reconnectDelay = null;

    this.rtt = rtt instanceof PowerHistogram ? rtt : new PowerHistogram({ relativeAccuracy: 0.02 });
    this._counters = {
      sent: 0,
      received: 0,
      drops: 0,
      decodeErrors: 0,
      reconnects: 0,
      heartbeatTimeouts: 0,
    };
  }

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
  get backpressureMode() {
    if (this._state !== READY_STATE.OPEN) return 'none';
    return this._writer ? 'streams' : 'watermark';
  }

  /** @returns {WebSocketReadyState} The socket's numeric ready state. */
  get readyState() {
    return this._state;
  }

  /** @returns {boolean} Whether the socket is open and accepting data. */
  get isOpen() {
    return this._state === READY_STATE.OPEN;
  }

  /**
   * Whether the producer is currently paused for back-pressure.
   * @returns {boolean}
   */
  get paused() {
    return this._paused;
  }

  /**
   * Bytes the socket has buffered and not yet handed to the network.
   * @returns {number}
   */
  get bufferedAmount() {
    return this._socket && this._state === READY_STATE.OPEN
      ? Number(this._socket.bufferedAmount) || 0
      : 0;
  }

  /**
   * Open the connection. Safe to call again to reconnect deliberately.
   * @returns {Promise<void>} Resolves once the socket is open, rejects on a
   *   failed connect or a connect timeout.
   */
  connect() {
    if (this._state === READY_STATE.CONNECTING || this._state === READY_STATE.OPEN) {
      return Promise.resolve();
    }
    this._closedByUser = false;
    return this._open();
  }

  /**
   * Close the connection and stop reconnecting.
   * @param {number} [code=1000] - WebSocket close code.
   * @param {string} [reason=''] - Human-readable reason.
   * @returns {void}
   */
  close(code = 1000, reason = '') {
    this._closedByUser = true;
    this._clearTimers();
    if (this._writer) {
      try {
        this._writer.abort?.();
      } catch (e) {
        this._emit('error', e);
      }
      this._writer = null;
    }
    if (this._socket) {
      try {
        this._socket.close(code, reason);
      } catch (e) {
        this._emit('error', e);
      }
    }
    this._setPaused(false);
    this._state = READY_STATE.CLOSED;
  }

  [Symbol.dispose]() {
    this.close();
  }

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
  async send(message, options = {}) {
    return this._transmit(encodeMessage(message, { codec: this._codec }), options);
  }

  /**
   * @private
   * @param {Uint8Array} frame
   * @param {Object} options
   * @returns {Promise<boolean>}
   */
  async _transmit(frame, options = {}) {
    if (this._state !== READY_STATE.OPEN || !this._socket) return false;

    if (this._writer) {
      // Streams tier: `ready` is the real back-pressure signal.
      try {
        await this._writer.ready;
        await this._writer.write(frame);
        this._counters.sent += 1;
        return true;
      } catch (e) {
        this._emit('error', e);
        return false;
      }
    }

    if (this.bufferedAmount > this._highWaterMark) {
      if (options.dropOnBackpressure) {
        this._counters.drops += 1;
        return false;
      }
      this._setPaused(true);
    }

    try {
      this._socket.send(frame);
      this._counters.sent += 1;
      return true;
    } catch (e) {
      this._emit('error', e);
      return false;
    }
  }

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
  async sendFrame(frame, options = {}) {
    if (this._state !== READY_STATE.OPEN || !this._socket) return false;
    if (!(frame instanceof Uint8Array)) {
      throw new TypeError(
        'PowerWebSocketClient.sendFrame() requires a Uint8Array. Use send() for a plain value.'
      );
    }
    return this._transmit(frame, options);
  }

  /**
   * Register a lifecycle handler.
   * @param {'message'|'open'|'close'|'error'|'pause'|'resume'} type
   * @param {Function} handler
   * @returns {function():void} An unsubscribe function.
   */
  on(type, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('PowerWebSocketClient.on() requires a function');
    }
    // A single handler per event, matching the rest of the library. Registering
    // again replaces; `off` clears. The returned function is a one-shot
    // unsubscribe that only detaches if it is still the active handler, so a
    // stale unsubscribe cannot remove a newer one.
    this._on[type] = handler;
    return () => {
      if (this._on[type] === handler) this._on[type] = null;
    };
  }

  /**
   * Remove a registered handler.
   * @param {'message'|'open'|'close'|'error'|'pause'|'resume'} type
   * @returns {void}
   */
  off(type) {
    this._on[type] = null;
  }

  /**
   * Counters plus heartbeat statistics.
   * @returns {object}
   */
  stats() {
    return {
      readyState: this._state,
      backpressureMode: this.backpressureMode,
      paused: this._paused,
      bufferedAmount: this.bufferedAmount,
      highWaterMark: this._highWaterMark,
      lowWaterMark: this._lowWaterMark,
      reconnectAttempts: this._reconnectAttempts,
      ...this._counters,
      rtt: {
        count: this.rtt.count,
        p50: this.rtt.count ? this.rtt.percentile(50) : undefined,
        p95: this.rtt.count ? this.rtt.percentile(95) : undefined,
        p99: this.rtt.count ? this.rtt.percentile(99) : undefined,
      },
    };
  }

  /**
   * Send an application-level ping. Only useful when the protocol allows it;
   * otherwise rely on the heartbeat, which uses whatever the transport offers.
   * @returns {void}
   */
  ping() {
    if (this._socket && typeof this._socket.ping === 'function') {
      try {
        this._socket.ping();
      } catch (e) {
        this._emit('error', e);
      }
    }
  }

  // ---------------------------------------------------------------- internals

  /**
   * @private
   * @returns {Promise<void>}
   */
  _open() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        this._clearConnectTimer();
        if (err) reject(err);
        else resolve();
      };

      try {
        this._state = READY_STATE.CONNECTING;
        if (this._WSStream) {
          // Streams tier, when the platform provides it.
          this._socket = new this._WSStream(this.url, this.protocols);
          this._writer = this._socket.writable?.getWriter?.() || null;
          this._socket.opened
            ?.then(() => this._handleOpen(done))
            .catch((e) => {
              this._handleError(e);
              done(e);
            });
        } else {
          this._socket = new this._WS(this.url, this.protocols);
          // Register through exactly ONE mechanism. Doing both would deliver
          // every event twice on a socket that supports both, silently
          // duplicating each message. `addEventListener` is preferred because
          // it does not clobber handlers the user set on the socket.
          if (typeof this._socket.addEventListener === 'function') {
            this._socket.addEventListener('open', () => this._handleOpen(done));
            this._socket.addEventListener('error', (e) => this._handleError(e));
            this._socket.addEventListener('close', (e) => this._handleClose(e));
            this._socket.addEventListener('message', (e) => this._handleMessage(e));
          } else {
            this._socket.onopen = () => this._handleOpen(done);
            this._socket.onerror = (e) => this._handleError(e);
            this._socket.onclose = (e) => this._handleClose(e);
            this._socket.onmessage = (e) => this._handleMessage(e);
          }
        }
      } catch (e) {
        this._state = READY_STATE.CLOSED;
        this._handleError(e);
        done(e);
        return;
      }

      if (this._connectTimeoutMs > 0) {
        this._connectTimer = setSafeTimeout(() => {
          this._connectTimer = null;
          if (this._state !== READY_STATE.OPEN) {
            const err = new Error(
              `PowerWebSocketClient: connect timed out after ${this._connectTimeoutMs}ms`
            );
            err.code = 'ERR_WS_CONNECT_TIMEOUT';
            try {
              this._socket?.close();
            } catch {
              /* ignore */
            }
            this._state = READY_STATE.CLOSED;
            done(err);
          }
        }, this._connectTimeoutMs);
      }
    });
  }

  /**
   * @private
   */
  _handleOpen(done) {
    if (this._state === READY_STATE.OPEN) {
      done();
      return;
    }
    this._state = READY_STATE.OPEN;
    this._reconnectAttempts = 0;
    this._lastPollInterval = this._pollBase;
    this._lastPongAt = nowMs();
    this._schedulePoll();
    this._scheduleHeartbeat();
    this._emit('open', this);
    done();
  }

  /**
   * @private
   */
  _handleMessage(event) {
    const data = event?.data ?? event;
    let message;
    try {
      message = decodeMessage(data).value;
    } catch (e) {
      // A frame we cannot parse is a protocol mismatch or a peer bug. Report it
      // and drop the message rather than tearing down a working socket.
      this._counters.decodeErrors += 1;
      this._emit('error', e);
      return;
    }
    this._counters.received += 1;
    this._emit('message', message, this);
  }

  /**
   * @private
   */
  _handleClose(event) {
    this._clearHeartbeat();
    this._stopPoll();
    this._setPaused(false);
    this._writer = null;
    this._state = READY_STATE.CLOSED;
    this._emit('close', event, this);
    if (!this._closedByUser) this._scheduleReconnect();
  }

  /**
   * @private
   */
  _handleError(err) {
    this._emit('error', err, this);
  }

  /**
   * Poll `bufferedAmount`, pausing and resuming the producer across the marks.
   * The interval backs off while paused so a stuck socket does not spin.
   * @private
   */
  _schedulePoll() {
    if (this._writer) return; // Streams tier: nothing to poll.
    if (this._state !== READY_STATE.OPEN) return;
    const interval = this._paused ? this._lastPollInterval : this._pollBase;
    this._lastPollInterval = Math.min(this._pollMax, Math.max(this._pollBase, interval * 2));
    this._pollTimer = setSafeTimeout(() => {
      this._pollTimer = null;
      this._tickWatermark();
      this._schedulePoll();
    }, interval);
  }

  /**
   * @private
   */
  _stopPoll() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * @private
   */
  _tickWatermark() {
    if (this._state !== READY_STATE.OPEN) return;
    const buffered = this.bufferedAmount;
    if (this._highWaterMark > 0 && buffered > this._highWaterMark) {
      this._setPaused(true);
      return;
    }
    if (this._paused && buffered <= this._lowWaterMark) this._setPaused(false);
  }

  /**
   * @private
   */
  _setPaused(paused) {
    if (this._paused === paused) return;
    this._paused = paused;
    // Reset the back-off when resuming so the next pause polls promptly.
    if (!paused) this._lastPollInterval = this._pollBase;
    this._emit(paused ? 'pause' : 'resume', this);
  }

  /**
   * @private
   */
  _scheduleHeartbeat() {
    if (this._heartbeatIntervalMs <= 0) return;
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
    if (this._socket && typeof this._socket.ping === 'function') {
      this._pingSentAt = nowMs();
      try {
        this._socket.ping();
      } catch (e) {
        this._emit('error', e);
      }
      if (this._heartbeatTimeoutMs > 0) {
        this._heartbeatDeadline = setSafeTimeout(() => {
          this._heartbeatDeadline = null;
          this._onHeartbeatTimeout();
        }, this._heartbeatTimeoutMs);
      }
    }
  }

  /**
   * @private
   */
  _onHeartbeatTimeout() {
    this._counters.heartbeatTimeouts += 1;
    this._clearHeartbeat();
    // A socket can sit in OPEN forever while nothing gets through - common
    // behind proxies and load balancers. Treat an unanswered heartbeat as
    // dead rather than waiting for a close event that may never come.
    if (this._reconnectOnHeartbeatTimeout && !this._closedByUser) {
      try {
        this._socket?.close(4000, 'heartbeat timeout');
      } catch (e) {
        this._emit('error', e);
      }
    }
  }

  /**
   * Decorrelated-jitter backoff, per AWS "Exponential Backoff and Jitter"
   * (2015). It decorrelates far better than full jitter under load, which
   * matters here because a server restart otherwise produces a synchronised
   * reconnect stampede from every client at once.
   * @private
   * @returns {number} Delay in ms.
   */
  _nextReconnectDelay() {
    if (this._reconnectDelay == null) this._reconnectDelay = this._reconnectBaseMs;
    const half = this._reconnectDelay / 2;
    const delay = Math.min(this._reconnectMaxMs, half + Math.random() * half);
    this._reconnectDelay = Math.min(this._reconnectMaxMs, this._reconnectDelay * 3);
    return Math.floor(delay);
  }

  /**
   * @private
   */
  _scheduleReconnect() {
    if (!this._autoReconnect || this._closedByUser) return;
    if (this._reconnectAttempts >= this._maxReconnectAttempts) return;
    this._reconnectAttempts += 1;
    this._counters.reconnects += 1;
    const delay = this._nextReconnectDelay();
    this._reconnectTimer = setSafeTimeout(() => {
      this._reconnectTimer = null;
      if (this._closedByUser) return;
      this._open().catch(() => {
        // `_handleClose` schedules the next attempt.
      });
    }, delay);
  }

  /**
   * @private
   */
  _clearConnectTimer() {
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
  }

  /**
   * @private
   */
  _clearHeartbeat() {
    if (this._heartbeatTimer) {
      clearTimeout(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._heartbeatDeadline) {
      clearTimeout(this._heartbeatDeadline);
      this._heartbeatDeadline = null;
    }
  }

  /**
   * @private
   */
  _clearTimers() {
    this._clearConnectTimer();
    this._clearHeartbeat();
    this._stopPoll();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectDelay = null;
  }

  /**
   * @private
   */
  _emit(type, ...args) {
    const handler = this._on[type];
    if (!handler) return;
    try {
      handler(...args);
    } catch (e) {
      // A failing user handler must not break the socket. Report through the
      // error channel if that is not the channel we are already on.
      if (type !== 'error') {
        const onError = this._on.error;
        if (onError) {
          try {
            onError(e, this);
          } catch {
            /* nothing left to do */
          }
        }
      }
    }
  }
}

export default PowerWebSocketClient;
