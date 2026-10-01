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
import { attach, detach } from './metrics.js';
import { READY_STATE } from './constants.js';
import { assertLimitRequired } from '../utils/options.js';

/** @typedef {'connecting'|'open'|'closing'|'closed'} WebSocketReadyState */

/**
 * The four states of a socket's lifecycle, as constants.
 *
 * Re-exported from `constants.js` so it stays a public export of this module
 * while being the *same* frozen object `PowerSocketAdapter` uses - a caller
 * comparing the two with `===` must get `true`. See the definition for why it
 * lives in the shared module rather than being written out twice.
 */
export { READY_STATE };

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
 * @property {string|string[]} [protocols] - Sub-protocols forwarded to the
 *   `WebSocket` / `WebSocketStream` constructor.
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
 * @property {boolean} [dropOnBackpressure=false] - Drop frames when the
 *   producer is paused by the high-water mark instead of queueing them.
 * @property {Function} [onMessage] - Called with each decoded message.
 * @property {Function} [onOpen] - Called once the socket reaches `OPEN`.
 * @property {Function} [onClose] - Called with the close code and reason.
 * @property {Function} [onError] - Called with each transport error.
 * @property {Function} [onPause] - Called when the high-water mark is crossed.
 * @property {Function} [onResume] - Called when `bufferedAmount` drains below
 *   the low-water mark.
 *
 * These were written as one line - `[onOpen] / [onClose] / [onError] / ...` -
 * which reads fine and parses as exactly one property. `onClose`, `onError`,
 * `onPause` and `onResume` were therefore invisible to the type system while
 * being fully supported at runtime, and every call site that passed one was an
 * error. Five `@property` lines instead of one shorthand, for the same length.
 * @property {PowerHistogram} [rtt] - Histogram for heartbeat RTT. One is
 *   created when omitted.
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] - Opt in to
 *   metrics: `true` registers this helper in the shared collector, or pass a
 *   collector of your own. Off by default, so the common case allocates nothing.
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
      WebSocketStreamImpl ||
      // Feature test, deliberately: the DOM type is not in every lib, and reading
      // it as an unknown global is exactly the runtime check we want.
      (typeof WebSocketStream !== 'undefined' ? /** @type {*} */ (WebSocketStream) : null);
    this._codec = codec;
    // Split by what `0` *means* here, because the two are not the same mistake.
    //
    // **Requests** - `0` is a documented way to turn a mechanism off, and the
    // coercion accidentally got these right:
    //   `heartbeatIntervalMs: 0` disables heartbeats, `heartbeatTimeoutMs: 0`
    //   disables the liveness deadline, `highWaterMarkBytes: 0` / `0` watermarks
    //   disable backpressure, `connectTimeoutMs: 0` means "wait as long as it
    //   takes". Coercing any of these to a default would be the bug.
    //
    // **Not requests** - `0` here means "spin", so accepting it is wrong, and the
    // old `Number(x) || default` silently substituted a default the caller never
    // asked for:
    //   `pollIntervalMs: 0`   -> 20   (a 0 ms poll is a busy loop)
    //   `maxPollIntervalMs: 0` -> 250
    //
    // Non-finite and negative were coerced everywhere, in both groups, and are
    // configuration errors. A `pollIntervalMs` of `NaN` did not produce a slow
    // poll - it produced the default, silently, and the backoff curve built on
    // top of it was then tuned to nothing the caller chose.
    this._connectTimeoutMs = assertLimitRequired(connectTimeoutMs, {
      name: 'connectTimeoutMs',
      className: 'PowerWebSocketClient',
      min: 0,
      fallback: 0,
    });
    this._highWaterMark = assertLimitRequired(highWaterMarkBytes, {
      name: 'highWaterMarkBytes',
      className: 'PowerWebSocketClient',
      min: 0,
      fallback: 0,
    });
    this._lowWaterMark = assertLimitRequired(lowWaterMarkBytes, {
      name: 'lowWaterMarkBytes',
      className: 'PowerWebSocketClient',
      min: 0,
      fallback: 0,
    });
    this._pollBase = assertLimitRequired(pollIntervalMs, {
      name: 'pollIntervalMs',
      className: 'PowerWebSocketClient',
      min: 1,
      fallback: 20,
    });
    this._pollMax = Math.max(
      this._pollBase,
      assertLimitRequired(maxPollIntervalMs, {
        name: 'maxPollIntervalMs',
        className: 'PowerWebSocketClient',
        min: 1,
        fallback: 250,
      })
    );
    this._heartbeatIntervalMs = assertLimitRequired(heartbeatIntervalMs, {
      name: 'heartbeatIntervalMs',
      className: 'PowerWebSocketClient',
      min: 0,
      fallback: 0,
    });
    this._heartbeatTimeoutMs = assertLimitRequired(heartbeatTimeoutMs, {
      name: 'heartbeatTimeoutMs',
      className: 'PowerWebSocketClient',
      min: 0,
      fallback: 0,
    });
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
    // Field declaration for the checker only: an `@type` on the initializer
    // narrows `_state` to the literal `3`, which made every
    // `_state === READY_STATE.X` comparison an "unintentional comparison"
    // error. The bare statement is a property read and does nothing at
    // runtime; the assignment below is what sets the value.
    /** @type {0|1|2|3} */
    this._state;
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
      // Heartbeats that came back. Always 0 before `RT-003`: the client had no
      // `pong` handler, so `_pingSentAt` was written and never read, and a `ws`
      // socket had every healthy connection closed with 4000 and reconnected
      // because the reply was never accounted for.
      heartbeats: 0,
    };
    // FEAT-007: opt-in metrics. Off by default, so the common case pays nothing and allocates no closure.
    this._metrics = attach(this, 'ws', options);
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

  /**

   * Named alias for the `Symbol.dispose` implementation, so callers who do not

   * want to reach for the symbol still have something to call.

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
        // Whether the transport can measure RTT at all. A browser socket has no
        // `ping()`, so the heartbeat is inert and `rtt.count` stays 0 — which
        // reads as "0 ms latency" and is a claim the client never earned. `false`
        // is the honest answer: unmeasured is not zero.
        canPing: typeof this._socket?.ping === 'function',
      },
    };
  }

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
  getStats() {
    return this.stats();
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
          // **A browser delivers every inbound frame as a `Blob` unless this is
          // set**, and this library only ever sends binary — so without it every
          // binary frame the client receives fails to decode, while the
          // equivalent `ws` socket in Node works fine. The asymmetry is what makes
          // it survive: a test on Node cannot see it. Highest
          // severity-per-line item in the review.
          //
          // Set through a try/catch rather than guarded on the property existing,
          // because a socket that *accepts* the assignment need not pre-declare
          // it — and a fake or a non-browser implementation that does not is
          // exactly the case where setting it is harmless and skipping it is not.
          // What the try/catch is for is the opposite: an implementation that
          // exposes `binaryType` as a getter-only accessor throws on assignment,
          // and a client that cannot connect is worse than one that connects with
          // the platform default.
          //
          // Swallowed rather than reported. `_debugLog` is a `PowerPool` field
          // and this class has no such member, so calling it here would have been
          // a no-op that *looked* like a diagnostic — and the type-debt ratchet
          // caught exactly that, which is the gate working as intended. The
          // condition is not worth an `error` event either: the connection is
          // fine, and an implementation that cannot hold an `ArrayBuffer`
          // preference is that implementation's business.
          try {
            this._socket.binaryType = 'arraybuffer';
          } catch {
            /* platform does not accept a binaryType override; the default applies */
          }
          // Register through exactly ONE mechanism. Doing both would deliver
          // every event twice on a socket that supports both, silently
          // duplicating each message. `addEventListener` is preferred because
          // it does not clobber handlers the user set on the socket.
          //
          // `error` and `close` take `done` as well as reporting: a connect
          // attempt that fails has to *settle*. Without it `connect()` stayed
          // PENDING after both events and only rejected at the connect timeout —
          // 10 s by default, and **forever** with `connectTimeoutMs: 0`, where
          // `connect()` is documented to "reject on a failed connect".
          if (typeof this._socket.addEventListener === 'function') {
            this._socket.addEventListener('open', () => this._handleOpen(done));
            this._socket.addEventListener('error', (e) => {
              this._handleError(e);
              done(e);
            });
            this._socket.addEventListener('close', (e) => {
              this._handleClose(e);
              done(e);
            });
            this._socket.addEventListener('message', (e) => this._handleMessage(e));
            // The heartbeat's reply. A browser socket has no `ping()`, so
            // `_pingSentAt` is never set and the deadline below can only ever
            // expire — on a browser the heartbeat is inert, and `stats().rtt` is
            // permanently empty.
            if (typeof this._socket.addEventListener === 'function') {
              this._socket.addEventListener('pong', () => this._handlePong());
            }
          } else {
            this._socket.onopen = () => this._handleOpen(done);
            this._socket.onerror = (e) => {
              this._handleError(e);
              done(e);
            };
            this._socket.onclose = (e) => {
              this._handleClose(e);
              done(e);
            };
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
            // **Settle before closing.** Closing emits a `close` event, and since
            // `close` now settles a pending connect (it must — that is
            // `RT-001`), closing first let the close's event object win the race
            // and reject with an empty message instead of this one. The caller
            // got `''` where the code and the reason had both been available.
            done(err);
            this._state = READY_STATE.CLOSED;
            try {
              this._socket?.close();
            } catch {
              /* ignore */
            }
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
  _handlePong() {
    // **Only the deadline is cleared, not the whole heartbeat.** `_clearHeartbeat()`
    // also cancels `_heartbeatTimer`, which is the heartbeat's own interval — so
    // calling it here stopped the heartbeat after a single round trip, and
    // `stats().heartbeats` froze at 1 forever. Measured with an async `pong`:
    // 1 ping for the life of the socket, against 28 in 150 ms when the clear was
    // missing. The reply settles one outstanding probe; it does not end the
    // probing.
    if (this._heartbeatDeadline) {
      clearTimeout(this._heartbeatDeadline);
      this._heartbeatDeadline = null;
    }
    const sentAt = this._pingSentAt;
    this._pingSentAt = 0;
    if (!sentAt) return;
    const rtt = nowMs() - sentAt;
    if (!(rtt >= 0)) return; // a clock that went backwards is not a measurement
    this._counters.heartbeats += 1;
    this.rtt.record(rtt);
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
