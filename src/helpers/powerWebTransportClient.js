/**
 * WebTransport client with back-pressure and reconnection.
 *
 * ## The problem this exists for
 *
 * `PowerWebSocketClient` covers the WebSocket case. WebTransport is the
 * HTTP/3 successor: same request/response shape, but the data path is streams
 * and datagrams rather than messages, and the platform does not provide
 * `ping()`/`pong()` or `bufferedAmount`. This client mirrors the
 * `PowerWebSocketClient` API so a hub can swap transports without changing
 * the call sites.
 *
 * ## On the wire
 *
 * Frames are encoded and decoded with {@link PowerMessageCodec}, so this pairs
 * directly with {@link PowerRealtimeHub} — pass {@link PowerWebTransportClient#send}
 * as the hub's `send` adapter.
 *
 * Inbound frames arrive from a `ReadableStream`; outbound frames are written
 * to a `WritableStream`. Back-pressure is the stream's `ready` promise, which
 * resolves when the transport has room — no watermark polling required.
 *
 * @module powerWebTransportClient
 * @public
 */
import { decodeMessage, encodeMessage, createFrameDecoder } from './powerMessageCodec.js';
import { PowerHistogram } from './powerHistogram.js';
import { setSafeTimeout } from '../utils/timers.js';
import { nowMs } from '../utils/now.js';
import { attach, detach } from './metrics.js';
import { assertLimitRequired, assertKnownOptions } from '../utils/options.js';

/** @typedef {'connecting'|'open'|'closing'|'closed'} WebTransportReadyState */

/**
 * The four states of a transport's lifecycle, as constants.
 *
 * Mirrors `READY_STATE` from `powerWebSocketClient` so callers can compare
 * with `===` across both transports.
 */
export const READY_STATE = Object.freeze({
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
});

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
 * @property {number} [maxPayloadSizeBytes=Infinity] - Maximum accepted size for
 *   incoming framed data. Oversized frames are rejected by the decoder and are
 *   not delivered.
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
  constructor(options = {}) {
    assertKnownOptions(
      options,
      [
        'url',
        'WebTransportImpl',
        'codec',
        'connectTimeoutMs',
        'maxPayloadSizeBytes',
        'heartbeatIntervalMs',
        'heartbeatTimeoutMs',
        'maxReconnectAttempts',
        'maxReconnectElapsedMs',
        'reconnectBaseMs',
        'reconnectMaxMs',
        'autoReconnect',
        'reconnectOnHeartbeatTimeout',
        'onMessage',
        'onOpen',
        'onClose',
        'onError',
        'rtt',
        'observability',
      ],
      'PowerWebTransportClient'
    );
    const {
      url,
      WebTransportImpl,
      codec = 'json',
      connectTimeoutMs = 10_000,
      maxPayloadSizeBytes = Infinity,
      heartbeatIntervalMs = 30_000,
      heartbeatTimeoutMs = 10_000,
      maxReconnectAttempts = Number.POSITIVE_INFINITY,
      maxReconnectElapsedMs = Number.POSITIVE_INFINITY,
      reconnectBaseMs = 500,
      reconnectMaxMs = 30_000,
      autoReconnect = true,
      reconnectOnHeartbeatTimeout = true,
      onMessage,
      onOpen,
      onClose,
      onError,
      rtt,
    } = options || {};

    if (typeof url !== 'string' || url === '') {
      throw new TypeError('PowerWebTransportClient: `url` must be a non-empty string');
    }
    if (codec !== 'json' && codec !== 'raw') {
      throw new TypeError("PowerWebTransportClient: `codec` must be 'json' or 'raw'");
    }

    this.url = url;
    this._WT = WebTransportImpl || (typeof WebTransport !== 'undefined' ? WebTransport : null);
    if (!this._WT) {
      throw new TypeError(
        'PowerWebTransportClient: no WebTransport implementation found. Pass `WebTransportImpl`.'
      );
    }
    this._codec = codec;

    this._connectTimeoutMs = assertLimitRequired(connectTimeoutMs, {
      name: 'connectTimeoutMs',
      className: 'PowerWebTransportClient',
      min: 0,
      fallback: 0,
    });
    this._maxPayloadSizeBytes = assertLimitRequired(maxPayloadSizeBytes, {
      name: 'maxPayloadSizeBytes',
      className: 'PowerWebTransportClient',
      min: 0,
      allowInfinity: true,
      fallback: Infinity,
    });
    this._heartbeatIntervalMs = assertLimitRequired(heartbeatIntervalMs, {
      name: 'heartbeatIntervalMs',
      className: 'PowerWebTransportClient',
      min: 0,
      fallback: 0,
    });
    this._heartbeatTimeoutMs = assertLimitRequired(heartbeatTimeoutMs, {
      name: 'heartbeatTimeoutMs',
      className: 'PowerWebTransportClient',
      min: 0,
      fallback: 0,
    });
    this._maxReconnectAttempts = assertLimitRequired(maxReconnectAttempts, {
      name: 'maxReconnectAttempts',
      className: 'PowerWebTransportClient',
      min: 0,
      integer: true,
      allowInfinity: true,
      fallback: Number.POSITIVE_INFINITY,
    });
    this._maxReconnectElapsedMs = assertLimitRequired(maxReconnectElapsedMs, {
      name: 'maxReconnectElapsedMs',
      className: 'PowerWebTransportClient',
      min: 0,
      allowInfinity: true,
      fallback: Number.POSITIVE_INFINITY,
    });
    this._reconnectBaseMs = assertLimitRequired(reconnectBaseMs, {
      name: 'reconnectBaseMs',
      className: 'PowerWebTransportClient',
      min: 1,
      integer: true,
      fallback: 500,
    });
    this._reconnectMaxMs = Math.max(
      this._reconnectBaseMs,
      assertLimitRequired(reconnectMaxMs, {
        name: 'reconnectMaxMs',
        className: 'PowerWebTransportClient',
        min: 1,
        integer: true,
        fallback: 30_000,
      })
    );
    this._autoReconnect = autoReconnect !== false;
    this._reconnectOnHeartbeatTimeout = reconnectOnHeartbeatTimeout !== false;

    this._on = {
      message: typeof onMessage === 'function' ? onMessage : null,
      open: typeof onOpen === 'function' ? onOpen : null,
      close: typeof onClose === 'function' ? onClose : null,
      error: typeof onError === 'function' ? onError : null,
    };

    this._transport = null;
    /** @type {WritableStreamDefaultWriter|null} */
    this._writer = null;
    /** @type {ReadableStreamDefaultReader|null} */
    this._reader = null;
    /** @type {TransformStream|undefined} */
    this._inboundTransform = undefined;
    /** @type {AbortController|null} */
    this._pumpAbort = null;

    /** @type {0|1|2|3} */
    this._state = READY_STATE.CLOSED;
    this._closedByUser = false;
    this._reconnectAttempts = 0;
    this._reconnectStartedAt = null;
    this._connectTimer = null;
    this._heartbeatTimer = null;
    this._heartbeatDeadline = null;
    this._reconnectTimer = null;
    this._reconnectDelay = null;

    this.rtt = rtt instanceof PowerHistogram ? rtt : new PowerHistogram({ relativeAccuracy: 0.02 });
    this._counters = {
      sent: 0,
      received: 0,
      drops: 0,
      decodeErrors: 0,
      oversizeFrames: 0,
      reconnects: 0,
      heartbeatTimeouts: 0,
      heartbeats: 0,
    };
    this._metrics = attach(this, 'wt', options);
  }

  /** @returns {BackpressureMode} */
  get backpressureMode() {
    return this._state === READY_STATE.OPEN && this._writer ? 'streams' : 'none';
  }

  /** @returns {0|1|2|3} */
  get readyState() {
    return this._state;
  }

  /** @returns {boolean} */
  get isOpen() {
    return this._state === READY_STATE.OPEN;
  }

  /**
   * Open the connection. Safe to call again to reconnect deliberately.
   * @returns {Promise<void>}
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
   * @param {number} [code=1000] - Close code.
   * @param {string} [reason=''] - Human-readable reason.
   * @returns {void}
   */
  close(code = 1000, reason = '') {
    this._closedByUser = true;
    this._clearTimers();
    if (this._reader) {
      try {
        this._reader.cancel();
      } catch {
        // ignore; reader is already closed or closing
      }
      this._reader = null;
    }
    if (this._writer) {
      try {
        this._writer.close();
      } catch {
        // ignore; writer is already closed or closing
      }
      this._writer = null;
    }
    if (this._transport) {
      try {
        this._transport.close(code, reason);
      } catch {
        // ignore; transport is already closed or closing
      }
      this._transport = null;
    }
    this._state = READY_STATE.CLOSED;
    this._emit('close', { code, reason }, this);
  }

  /**
   * Named alias for `Symbol.dispose`.
   * @returns {void}
   */
  dispose() {
    detach(this._metrics);
    this._metrics = null;
    this[Symbol.dispose]();
  }

  [Symbol.dispose]() {
    this.close();
  }

  /**
   * Asynchronous disposal hook.
   * @returns {Promise<void>}
   */
  async [Symbol.asyncDispose]() {
    this.dispose();
  }

  /**
   * Send a message, applying back-pressure.
   *
   * @param {any} message
   * @param {{dropOnBackpressure?: boolean}} [options]
   * @returns {Promise<boolean>} `true` when the frame was handed to the transport.
   */
  async send(message, options = {}) {
    return this._transmit(encodeMessage(message, { codec: this._codec }), options);
  }

  /**
   * Send an already-framed payload.
   * @param {Uint8Array} frame
   * @param {Object} [options]
   * @returns {Promise<boolean>}
   */
  async sendFrame(frame, options = {}) {
    if (this._state !== READY_STATE.OPEN || !this._writer) return false;
    if (!(frame instanceof Uint8Array)) {
      throw new TypeError(
        'PowerWebTransportClient.sendFrame() requires a Uint8Array. Use send() for a plain value.'
      );
    }
    return this._transmit(frame, options);
  }

  /**
   * Register a lifecycle handler.
   * @param {'message'|'open'|'close'|'error'} type
   * @param {Function} handler
   * @returns {function():void}
   */
  on(type, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('PowerWebTransportClient.on() requires a function');
    }
    this._on[type] = handler;
    return () => {
      if (this._on[type] === handler) this._on[type] = null;
    };
  }

  /**
   * Remove a registered handler.
   * @param {'message'|'open'|'close'|'error'} type
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
      ...this._counters,
      rtt: {
        count: this.rtt.count,
        p50: this.rtt.count ? this.rtt.percentile(50) : undefined,
        p95: this.rtt.count ? this.rtt.percentile(95) : undefined,
        p99: this.rtt.count ? this.rtt.percentile(99) : undefined,
        canPing: false,
      },
    };
  }

  /**
   * Alias for {@link stats}.
   * @returns {object}
   */
  getStats() {
    return this.stats();
  }

  /**
   * Send an application-level ping.
   * @returns {void}
   */
  ping() {
    // WebTransport has no native ping; a no-op keeps the hub's heartbeat path
    // callable without branching on transport type.
  }

  // ---------------------------------------------------------------- internals

  /**
   * @private
   * @returns {Promise<void>}
   */
  async _open() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (/** @type {any} */ err) => {
        if (settled) return;
        settled = true;
        this._clearConnectTimer();
        if (err) reject(err);
        else resolve();
      };

      try {
        this._state = READY_STATE.CONNECTING;
        const transport = new this._WT(this.url);
        this._transport = transport;

        transport.closed
          ?.then(() => {
            this._handleClose({ code: transport.closeCode, reason: transport.closeReason });
            done();
          })
          .catch((/** @type {any} */ e) => {
            this._handleError(e);
            done(e);
          });

        // Wait for the transport to be reliable enough to create streams.
        // `ready` is the Baseline signal that the handshake is complete.
        const readyPromise = transport.ready;
        if (!readyPromise) {
          done(new Error('PowerWebTransportClient: transport does not expose `ready`'));
          return;
        }

        readyPromise
          .then(() => {
            this._handleOpen(done);
          })
          .catch((/** @type {any} */ e) => {
            this._handleError(e);
            done(e);
          });
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
              `PowerWebTransportClient: connect timed out after ${this._connectTimeoutMs}ms`
            );
            done(err);
            this._state = READY_STATE.CLOSED;
            try {
              this._transport?.close();
            } catch {
              /* ignore; transport is already closed or closing */
            }
          }
        }, this._connectTimeoutMs);
      }
    });
  }

  /**
   * @param {(err?: any) => void} done
   * @private
   */
  _handleOpen(done) {
    if (this._state === READY_STATE.OPEN) {
      done();
      return;
    }
    this._state = READY_STATE.OPEN;
    this._reconnectAttempts = 0;
    this._reconnectDelay = null;
    this._reconnectStartedAt = null;
    this._lastPollInterval = this._pollBase;
    this._scheduleHeartbeat();
    this._startStreamPump();
    this._emit('open', this);
    done();
  }

  /**
   * @private
   */
  _startStreamPump() {
    if (!this._transport) return;
    const transport = this._transport;

    // Create a bidirectional stream for the data path.
    const stream = transport.createBidirectionalStream?.();
    if (!stream) {
      this._handleError(
        new Error('PowerWebTransportClient: transport has no bidirectional streams')
      );
      return;
    }

    const decoder = createFrameDecoder({ maxFrameBytes: this._maxPayloadSizeBytes });
    const transform = new TransformStream({
      transform(chunk, controller) {
        const frames = decoder.push(chunk);
        for (const frame of frames) {
          controller.enqueue(frame.value);
        }
      },
      flush(controller) {
        const remaining = decoder.flush();
        if (remaining.length > 0) {
          controller.enqueue(remaining);
        }
      },
    });
    this._inboundTransform = transform;

    // Pump readable -> transform.
    const reader = stream.readable.getReader();
    const writer = transform.writable.getWriter();
    this._reader = reader;
    this._pumpAbort = new AbortController();

    const pump = async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      } catch (e) {
        // Stream closed or aborted.
      } finally {
        reader.releaseLock();
        try {
          await writer.close();
        } catch {
          // ignore; writer is already closed or closing
        }
      }
    };

    pump().catch(() => {
      // Pump failures are reported through the close path.
    });

    // Read decoded frames from the transform.
    const frameReader = transform.readable.getReader();
    const readFrames = async () => {
      try {
        while (true) {
          const { value, done } = await frameReader.read();
          if (done) break;
          this._deliverFrame(value);
        }
      } catch {
        // ignore; stream is closed or aborted
      }
    };
    readFrames().catch(() => {});

    // Writer for outbound frames.
    this._writer = stream.writable.getWriter();
  }

  /**
   * @param {*} data
   * @private
   */
  _deliverFrame(data) {
    let message;
    try {
      message = decodeMessage(data).value;
    } catch (e) {
      this._counters.decodeErrors += 1;
      this._emit('error', e);
      return;
    }
    this._counters.received += 1;
    this._emit('message', message, this);
  }

  /**
   * @param {{code?: number, reason?: string}} [event]
   * @private
   */
  _handleClose(event) {
    this._clearHeartbeat();
    this._state = READY_STATE.CLOSED;
    this._writer = null;
    this._reader = null;
    this._transport = null;
    this._emitCloseAndReconnect(event);
  }

  /**
   * @param {{code?: number, reason?: string}} [event]
   * @private
   */
  _emitCloseAndReconnect(event) {
    this._emit('close', event, this);
    if (!this._closedByUser && this._autoReconnect) {
      if (this._reconnectStartedAt === null) this._reconnectStartedAt = nowMs();
      this._scheduleReconnect();
    }
  }

  /**
   * @param {any} err
   * @private
   */
  _handleError(err) {
    this._emit('error', err, this);
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
    if (!this._writer) return;
    // Send a small heartbeat frame.
    const heartbeat = encodeMessage({ __heartbeat: true }, { codec: this._codec });
    this._writer.write(heartbeat).catch(() => {
      /* ignore */
    });
    this._counters.sent += 1;

    // Arm a deadline for the reply.
    this._heartbeatDeadline = setSafeTimeout(() => {
      this._heartbeatDeadline = null;
      this._onHeartbeatTimeout();
    }, this._heartbeatTimeoutMs);
  }

  /**
   * @private
   */
  _onHeartbeatTimeout() {
    this._counters.heartbeatTimeouts += 1;
    this._clearHeartbeat();
    if (this._reconnectOnHeartbeatTimeout && !this._closedByUser) {
      try {
        this._transport?.close(4000, 'heartbeat timeout');
      } catch (e) {
        this._emit('error', e);
      }
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
  _scheduleReconnect() {
    if (!this._autoReconnect || this._closedByUser) return;
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this._counters.reconnects += 1;
      return;
    }
    if (
      this._maxReconnectElapsedMs !== Number.POSITIVE_INFINITY &&
      this._reconnectStartedAt !== null &&
      nowMs() - this._reconnectStartedAt >= this._maxReconnectElapsedMs
    ) {
      this._counters.reconnects += 1;
      return;
    }
    this._reconnectAttempts += 1;
    this._counters.reconnects += 1;
    const delay = this._nextReconnectDelay();
    this._reconnectTimer = setSafeTimeout(() => {
      this._reconnectTimer = null;
      if (this._closedByUser) return;
      this._open().catch(() => {
        // _handleClose schedules the next attempt.
      });
    }, delay);
  }

  /**
   * @private
   * @returns {number}
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
  _clearConnectTimer() {
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
  }

  /**
   * @private
   */
  _clearTimers() {
    this._clearHeartbeat();
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectDelay = null;
  }

  /**
   * @param {string} type
   * @param {...any} args
   * @private
   */
  _emit(type, ...args) {
    const handler = this._on[type];
    if (!handler) return;
    try {
      handler(...args);
    } catch (e) {
      if (type !== 'error') {
        const onError = this._on.error;
        if (onError) {
          try {
            onError(e, this);
          } catch {
            // nothing left to do
          }
        }
      }
    }
  }

  /**
   * @param {Uint8Array} frame
   * @private
   * @returns {Promise<boolean>}
   */
  async _transmit(frame) {
    if (this._state !== READY_STATE.OPEN || !this._writer) return false;

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
}
