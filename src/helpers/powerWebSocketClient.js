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
import { sendHeartbeatProbe, settleHeartbeatProbe } from '../utils/liveness.js';
import { attach, detach } from './metrics.js';
import { READY_STATE } from './constants.js';
import { assertLimitRequired, assertKnownOptions } from '../utils/options.js';
import { frameByteLength } from '../utils/frameSize.js';
import { oversizedFrameError } from '../utils/errors.js';

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
 * @property {number} [maxPayloadSizeBytes=Infinity] - Frames larger than this are
 *   **reported, not prevented** — and the distinction is the point, so read this
 *   before relying on it.
 *
 *   By the time a `message` event fires, the platform has already received and
 *   materialised the whole frame. Nothing at this layer can stop that allocation,
 *   so this option **counts** the oversized frame (`stats().oversizeFrames`) and
 *   emits an `error` saying what arrived. It is observability, not a guard: a
 *   number that reads like a limit and is not one is worse than no number, which
 *   is why it is described this way in the option, in the error message and here.
 *
 *   **Prevention belongs at the peer that produces the frame.** And the codec is
 *   already safe regardless: `decodeMessage` validates a declared payload length
 *   against the bytes actually present *before* slicing, so a frame lying about
 *   its size throws instead of reserving anything, and the payload is a view
 *   rather than a copy. The incremental decoder's equivalent bound —
 *   `createFrameDecoder`'s `maxFrameBytes` — is **required** rather than
 *   defaulted, because a peer that sends a header and then stops would otherwise
 *   pin its buffer at whatever size it named.
 *
 *   Defaults to `Infinity`, which disables the report; `0` disables it too, the
 *   same convention `highWaterMarkBytes: 0` uses in this class. Set it to the
 *   largest frame your peer should ever send, and alert on `oversizeFrames`.
 *
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
 * @property {number} [maxReconnectElapsedMs=Infinity] - Wall-clock ceiling on
 *   one reconnect run, in milliseconds. Unlike {@link maxReconnectAttempts},
 *   which counts attempts, this bounds the *time* spent retrying — so a backoff
 *   schedule that has stretched its delay out is stopped on wall-clock grounds
 *   rather than waiting for an attempt count nobody can predict.
 *
 *   Defaults to `Infinity`, which is **no bound** and preserves today's
 *   behaviour. That default is the anti-pattern named in GAP-010 — *"Should I
 *   reconnect a WebSocket forever? No. Set a maximum retry count (10–15) or a
 *   maximum elapsed time (2–5 minutes)"* — and a finite default is a breaking
 *   change, so it is scheduled for 3.0 rather than smuggled into this release.
 *   Set it here for now.
 *
 *   The budget covers **one outage**: it is reset when a connection opens, so a
 *   long-lived connection that drops an hour later gets a fresh window rather
 *   than inheriting the previous one's exhaustion. That is the same window
 *   `maxReconnectAttempts` bounds, and the two compose.
 *
 * @property {number} [maxReconnectAttempts=Infinity] - `Infinity` retries
 *   forever with decorrelated-jitter backoff.
 * @property {number} [reconnectBaseMs=500] - Base delay for the backoff.
 * @property {number} [reconnectMaxMs=30000] - Ceiling for the backoff.
 * @property {boolean} [autoReconnect=true] - Reconnect on an unexpected close.
 * @property {number[]} [nonRetryableCloseCodes=[]] - Close codes that **end**
 *   the client rather than being retried. RT-014.
 *
 *   **Opt-in, and `[]` by default, so nothing changes until it is configured.**
 *   A `close` event whose `code` is in this list skips the whole reconnect
 *   decision: no attempt is counted, no backoff delay is armed, and
 *   `stats().reconnectExhaustedBy` becomes `'close-code'`. The client is left
 *   exactly where a caller-initiated `close()` leaves it — `readyState` `3`
 *   (`CLOSED`), the `close` event already emitted, no timer pending.
 *
 *   The reason it exists is the stampede the backoff cannot prevent. A `1008`
 *   (policy violation), `1001` (going away) or `1002` (protocol error) close is
 *   the *same* answer for every client of a service, delivered immediately, so
 *   decorrelated jitter has nothing to decorrelate — it spreads the retries
 *   after the decision, not the decision itself. Declaring the code makes "this
 *   is not retryable" a property of the application rather than a property of
 *   the outage.
 *
 *   **The check runs before every other input to the reconnect decision** —
 *   `autoReconnect`, `maxReconnectAttempts`, `maxReconnectElapsedMs` — and so
 *   before any future `shouldReconnect` callback, because a caller's own
 *   predicate must not be able to re-enable a reconnect on a code the caller
 *   just declared non-retryable. No `shouldReconnect` option exists on this
 *   class today, so the inputs being short-circuited are the built-in ones.
 *
 *   **A numeric string in the list matches the numeric `event.code`**, so
 *   `'1008'` and `1008` behave identically. A list that silently matched
 *   nothing is the one failure direction this option must not have: a code
 *   read out of JSON, an environment variable or a query string arrives as a
 *   string, and an ineffective list is indistinguishable from no list at all —
 *   the client reconnects for ever, which is the defect being fixed. For the
 *   same reason RT-013 validates `maxReconnectAttempts` rather than coercing
 *   it, an entry that is not a code (`NaN`, `null`, `''`, `'close'`, an object)
 *   **throws** at construction instead of being dropped: a dropped entry is a
 *   list the caller believes in and the client ignores. Duplicates and `[]`
 *   are legal.
 *
 *   A pending `connect()` promise is unaffected. A close arriving before `open`
 *   settles it with the close event — the pre-existing RT-001 path, unchanged —
 *   and a close after `open` has nothing left to settle. Call `connect()` again
 *   to retry deliberately; the client is not latched.
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
 * RT-014: the one place a close code is read as a number.
 *
 * **A numeric string is accepted, and this is the only place that decision is
 * made** — both the constructor's validation and the close handler go through
 * it, so "does `'1008'` match `1008`?" has exactly one answer in the codebase.
 * The reasoning is on the option: a list that silently matches nothing is
 * indistinguishable from no list, and the failure it produces is the
 * reconnect-for-ever behaviour the option exists to stop. The dangerous
 * direction is a lenient read; a strict one would need a `close`-code list
 * written in exactly one type, which is not something a JSON config or a query
 * string can be relied on to do.
 *
 * `NaN` is returned for anything that is not a code, and that is the right
 * "no code" value rather than a sentinel: `NaN === NaN` is false, so a bad
 * entry cannot match a bad `event.code` either, and it keeps the two traps
 * `Number()` falls into — `Number(null) === 0` would let a stray `null` match
 * close code 0, `Number([]) === 0` likewise — out of reach. `±Infinity` goes the
 * same way even though it is a `number`: a close code is a `uint16`, so it can
 * never be an infinite one, and accepting it would store an entry that can never
 * match anything — the same "looks configured, does nothing" shape as a bad one.
 *
 * @param {*} value A close code as the caller configured it, or the `code` from
 *   a `CloseEvent`.
 * @returns {number} The code, or `NaN` when the value is not one.
 * @private
 */
function closeCodeNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  // `trim() !== ''` is what rejects `''` and `'  '`, which `Number()` answers
  // with 0 — the same trap as `null`, arrived at from the other direction.
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

/**
 * Whether an incoming close code is one the caller declared non-retryable.
 *
 * @param {readonly number[]} codes Already normalised by the constructor, which
 *   is why the scan compares numbers with `===` and does no coercion of its own.
 * @param {*} code The `CloseEvent.code`, or `undefined` on a synthetic close.
 * @returns {boolean}
 * @private
 */
function matchesCloseCode(codes, code) {
  const target = closeCodeNumber(code);
  if (Number.isNaN(target)) return false;
  for (const candidate of codes) {
    if (candidate === target) return true;
  }
  return false;
}

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
    assertKnownOptions(
      options,
      [
        'url',
        'WebSocketImpl',
        'WebSocketStreamImpl',
        'codec',
        'connectTimeoutMs',
        'highWaterMarkBytes',
        'lowWaterMarkBytes',
        'pollIntervalMs',
        'protocols',
        'maxPollIntervalMs',
        'maxPayloadSizeBytes',
        'heartbeatIntervalMs',
        'heartbeatTimeoutMs',
        'maxReconnectAttempts',
        'maxReconnectElapsedMs',
        'reconnectBaseMs',
        'reconnectMaxMs',
        'autoReconnect',
        'nonRetryableCloseCodes',
        'reconnectOnHeartbeatTimeout',
        'dropOnBackpressure',
        'onMessage',
        'onOpen',
        'onClose',
        'onError',
        'onPause',
        'onResume',
        'rtt',
        'observability',
      ],
      'PowerWebSocketClient'
    );
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
      maxPayloadSizeBytes = Infinity,
      heartbeatIntervalMs = 30_000,
      heartbeatTimeoutMs = 10_000,
      maxReconnectAttempts = Number.POSITIVE_INFINITY,
      maxReconnectElapsedMs = Number.POSITIVE_INFINITY,
      reconnectBaseMs = 500,
      reconnectMaxMs = 30_000,
      autoReconnect = true,
      nonRetryableCloseCodes = [],
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
    // RT-014. A non-array throws rather than being coerced, in the same shape as
    // the option checks above: `null` and a bare number both reach here (the
    // destructuring default only covers `undefined`) and both would otherwise be
    // iterated or length-read into a decision nobody made.
    if (!Array.isArray(nonRetryableCloseCodes)) {
      throw new TypeError(
        'PowerWebSocketClient: `nonRetryableCloseCodes` must be an array of close codes ' +
          `(received ${String(nonRetryableCloseCodes)}). An entry that is not a code ` +
          'matches nothing, which is indistinguishable from not configuring the option.'
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
    const globalObj = /** @type {Record<string, *>} */ (/** @type {*} */ (globalThis));
    this._WSStream =
      WebSocketStreamImpl ||
      // Feature test, deliberately: the DOM type is not in every lib, and reading
      // it as an unknown global is exactly the runtime check we want.
      //
      // Read off `globalThis` through an index rather than as a bare identifier,
      // because a bare `WebSocketStream` is resolved when the *program* is built:
      // without the DOM lib that is a compile error, raised before the runtime
      // check below ever runs. So the identifier spelling could not perform the
      // feature test it was written to perform - it failed the build instead of
      // answering the question.
      (typeof globalObj.WebSocketStream !== 'undefined' ? globalObj.WebSocketStream : null);
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
    // RT-009. `allowInfinity` because `Infinity` is the documented default and
    // means "do not report" — the same deliberate opt-in `createFrameDecoder`
    // takes for `maxFrameBytes`. `min: 0` is accepted because `0` *disables* the
    // check, which this class already spells that way for its watermarks; without
    // it, `0` would be rejected rather than meaning "no limit".
    this._maxPayloadSizeBytes = assertLimitRequired(maxPayloadSizeBytes, {
      name: 'maxPayloadSizeBytes',
      className: 'PowerWebSocketClient',
      min: 0,
      allowInfinity: true,
      fallback: Infinity,
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
    // RT-013. Validated rather than assigned, because the gate at the bottom of
    // this class reads `this._reconnectAttempts >= this._maxReconnectAttempts`,
    // and **every comparison with `NaN` is false**. So `maxReconnectAttempts: NaN`
    // did not mean "no reconnects" — it meant the bound never trips and the client
    // reconnects for ever. That is the `maxEntries: NaN` failure mode
    // `utils/options.js` was written to kill, in a file carrying an essay about not
    // doing it. `allowInfinity` because `Infinity` is the documented default and
    // means "no attempt bound".
    this._maxReconnectAttempts = assertLimitRequired(maxReconnectAttempts, {
      name: 'maxReconnectAttempts',
      className: 'PowerWebSocketClient',
      min: 0,
      integer: true,
      allowInfinity: true,
      fallback: Number.POSITIVE_INFINITY,
    });
    // GAP-010. `allowInfinity` because `Infinity` is the documented default and
    // means "no elapsed bound" — deliberately, since a finite default is a
    // behaviour change reserved for 3.0.
    this._maxReconnectElapsedMs = assertLimitRequired(maxReconnectElapsedMs, {
      name: 'maxReconnectElapsedMs',
      className: 'PowerWebSocketClient',
      min: 0,
      allowInfinity: true,
      fallback: Number.POSITIVE_INFINITY,
    });
    // When the current reconnect run began, or `null` when no run is in progress.
    // Reset alongside `_reconnectAttempts` in `_handleOpen`, so both bounds
    // describe the same outage — one that stops because it ran out of attempts
    // and one that stops because it ran out of time are the same condition.
    this._reconnectStartedAt = null;
    // RT-013. These were `Number(x) || default`, which is not validation: it maps
    // `NaN` to the default *silently*, and it maps `0` to the default too — so a
    // caller who asked for a zero base delay got 500 ms and no diagnostic. `min: 1`
    // keeps the old `Math.max(1, ...)` floor, because a zero base delay is a hot
    // reconnect loop, and `integer` keeps the backoff arithmetic below whole.
    this._reconnectBaseMs = assertLimitRequired(reconnectBaseMs, {
      name: 'reconnectBaseMs',
      className: 'PowerWebSocketClient',
      min: 1,
      integer: true,
      fallback: 500,
    });
    // Still clamped up to the base, as before: a ceiling below the base would make
    // the backoff non-monotonic, and that was true before this row as well.
    this._reconnectMaxMs = Math.max(
      this._reconnectBaseMs,
      assertLimitRequired(reconnectMaxMs, {
        name: 'reconnectMaxMs',
        className: 'PowerWebSocketClient',
        min: 1,
        integer: true,
        fallback: 30_000,
      })
    );
    this._autoReconnect = autoReconnect !== false;
    // RT-014. Normalised **once**, into a fresh array, so the close path is a
    // plain number comparison — a close event can arrive for the life of the
    // process, and re-reading strings on it would be work the constructor
    // already had the chance to do. A copy, because the caller's array is still
    // theirs: mutating the list after construction must not silently change
    // which codes end the client. Duplicates are left in place — a scan does not
    // care, and dropping them would imply a de-duplication this does not promise.
    this._nonRetryableCloseCodes = nonRetryableCloseCodes.map((code, i) => {
      const n = closeCodeNumber(code);
      // Throws rather than skipping, which is the `maxReconnectAttempts: NaN`
      // lesson (RT-013) applied to a list: a silently dropped entry is a code
      // the caller believes is protected and is not.
      if (Number.isNaN(n)) {
        throw new TypeError(
          `PowerWebSocketClient: \`nonRetryableCloseCodes[${i}]\` must be a close code as ` +
            `a number or a numeric string (received ${String(code)}). An entry that is not ` +
            'a code matches nothing, so the client would reconnect exactly as if the list ' +
            'were empty.'
        );
      }
      return n;
    });
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
    /** @type {ReadableStreamDefaultReader|null} */
    // Held so `close()` can cancel it. The streams tier's inbound path depends on
    // this existing at all: nothing else in the class ever takes a reader.
    this._streamReader = null;
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
    this._reconnectExhaustedBy = null;
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
      // RT-009: frames received over `maxPayloadSizeBytes`. A count rather than a
      // rejection, because by this point the platform has already materialised
      // the frame — see the option's documentation.
      oversizeFrames: 0,
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
    if (this._streamReader) {
      // Cancel before the writer: a pending `read()` holds the stream lock, and
      // aborting the write side does not release it. Left uncancelled, every
      // reconnect leaks a lock and the replacement stream cannot hand out a
      // reader — so the next connection would be deaf for a different reason.
      try {
        this._streamReader.cancel?.();
      } catch (e) {
        this._emit('error', e);
      }
      this._streamReader = null;
    }
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
    // RT-015. `_setPaused(false)` emits `resume`, and closing is terminal: a
    // producer wired as `onResume: () => feed.resume()` would restart feeding a
    // socket that is CLOSED on the very next line. Measured: closing a paused
    // client emitted one `resume` with `readyState` already 3. The state is set
    // directly here, so the teardown is silent.
    //
    // `_lastPollInterval` is deliberately left alone. Polling was already stopped
    // by `_clearTimers()` above, and `_handleOpen` resets it for the next
    // connection, so there is nothing to reset that is not already handled.
    this._paused = false;
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
  async [Symbol.asyncDispose]() {
    this.dispose();
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
   * @param {{dropOnBackpressure?: boolean}} [options] - When the socket is
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
      // GAP-010: *why* reconnection stopped, or `null` while it has not.
      // `'attempts'` and `'elapsed'` are the two bounds this client applies, and
      // they mean different things to whoever is alerting — a run stopped by a
      // count suggests the peer is refusing; one stopped by the clock suggests
      // the outage outlived the budget. `Infinity` on both defaults means neither
      // can fire, so this stays `null` for the default configuration.
      //
      // RT-014 adds a third value, `'close-code'`, for a close whose code is in
      // `nonRetryableCloseCodes`. It is not a bound that ran out — nothing was
      // attempted — but it answers the same question ("why did it stop?"), and
      // without it a declared non-retryable close is indistinguishable from
      // `autoReconnect: false` or a caller-initiated `close()`. The most recent
      // terminal reason is the one reported, so a code arriving after an
      // exhausted budget overwrites `'attempts'`.
      reconnectExhaustedBy: this._reconnectExhaustedBy ?? null,
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
      const done = (/** @type {any} */ err) => {
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
            ?.then(() => {
              this._handleOpen(done);
              // **The read side, which this tier did not have.** `writable` was
              // acquired two lines up and `message` is wired only in the
              // `WebSocket` branch below, so before this the streams tier
              // opened, sent and received nothing — with no error and no
              // counter, because nothing ever looked. `PowerSocketAdapter` had
              // already hit the identical shape and fixed it by detecting the
              // tier on `readable.getReader` rather than on truthiness (its
              // `readable`/`writable` *booleans* on a Node `Duplex` matched
              // every TCP socket in existence); see `guides/powerSocketAdapter.md`.
              // Detection is not the problem here — `_WSStream` is a constructor,
              // not a flag — so the missing half was simply the reader.
              //
              // Started after `opened` because a `WebSocketStream` reports
              // `readable: null` until the connection opens, and that object is
              // still a stream. Waiting is not optional: acquiring a reader
              // earlier throws.
              this._startStreamPump();
            })
            .catch((/** @type {any} */ e) => {
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
            this._socket.addEventListener('error', (/** @type {any} */ e) => {
              this._handleError(e);
              done(e);
            });
            this._socket.addEventListener('close', (/** @type {any} */ e) => {
              this._handleClose(e);
              done(e);
            });
            this._socket.addEventListener('message', (/** @type {any} */ e) =>
              this._handleMessage(e)
            );
            // The heartbeat's reply. A browser socket has no `ping()`, so
            // `_pingSentAt` is never set and the deadline below can only ever
            // expire — on a browser the heartbeat is inert, and `stats().rtt` is
            // permanently empty.
            if (typeof this._socket.addEventListener === 'function') {
              this._socket.addEventListener('pong', () => this._handlePong());
            }
          } else {
            this._socket.onopen = () => this._handleOpen(done);
            this._socket.onerror = (/** @type {any} */ e) => {
              this._handleError(e);
              done(e);
            };
            this._socket.onclose = (/** @type {any} */ e) => {
              this._handleClose(e);
              done(e);
            };
            this._socket.onmessage = (/** @type {any} */ e) => this._handleMessage(e);
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
            const err = /** @type {Error & {code: 'ERR_WS_CONNECT_TIMEOUT'}} */ (
              new Error(`PowerWebSocketClient: connect timed out after ${this._connectTimeoutMs}ms`)
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
   * @param {(err?: any) => void} done Settles the pending connect exactly once.
   * @private
   */
  _handleOpen(done) {
    if (this._state === READY_STATE.OPEN) {
      done();
      return;
    }
    this._state = READY_STATE.OPEN;
    this._reconnectAttempts = 0;
    // RT-012. The **backoff** is per outage too, and it was the one thing on this
    // path not cleared here. `_nextReconnectDelay()` triples `_reconnectDelay` on
    // every call and caps it at `reconnectMaxMs`, so an outage that ran long left
    // the *next* outage starting from the grown value — measured: three retries
    // grow it to 2700 ms with a base of 100, and a successful open left it there,
    // so the following outage's first retry waited 2700 ms rather than ~100. Run
    // long enough and the first retry of every subsequent outage waits the full
    // 30 s ceiling. `guides/powerWebSocketClient.md` has claimed a successful open
    // resets the backoff; this is what makes that true rather than aspirational.
    this._reconnectDelay = null;
    // The elapsed budget covers one outage, so a fresh connection clears it —
    // and clears the reason with it, since nothing is exhausted any more.
    this._reconnectStartedAt = null;
    this._reconnectExhaustedBy = null;
    this._lastPollInterval = this._pollBase;
    this._lastPongAt = nowMs();
    this._schedulePoll();
    this._scheduleHeartbeat();
    this._emit('open', this);
    done();
  }

  /**
   * @param {{data?: any}} event The DOM `MessageEvent`, or the bare payload when
   *   the caller delivers one directly - hence `event?.data ?? event`.
   * @private
   */
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
  _startStreamPump() {
    const readable = this._socket?.readable;
    if (!readable || typeof readable.getReader !== 'function') return;
    let reader;
    try {
      reader = readable.getReader();
    } catch (e) {
      this._handleError(e);
      return;
    }
    this._streamReader = reader;
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          // The stream yields the frame itself, so there is no event to unwrap.
          // `_handleMessage` reads `event?.data ?? event`, which passes a
          // `Uint8Array` straight through and unwraps a real `MessageEvent` on
          // the socket tier — the same call serves both, which is why the tier
          // does not need its own decode path.
          this._handleMessage(value);
        }
      } catch (e) {
        this._handleError(e);
      }
    })();
  }

  _handleMessage(event) {
    const data = event?.data ?? event;

    // RT-009: **detection, not prevention**, and the wording is load-bearing.
    // By the time a `message` event fires the platform has already materialised
    // the whole frame, so this limit cannot stop the allocation — it reports a
    // frame that exceeded it, after the fact. A number that sounds like a limit
    // and is not is worse than no number, which is why the option is documented
    // this way in three places rather than as protection.
    //
    // It is still worth having: a peer that sends 40 MB frames is a fact you want
    // in `stats()` and in your logs, and `_counters.oversizeFrames` makes it
    // alertable. The prevention belongs at the edge that owns the bytes — the
    // server, or a proxy in front of it.
    const size = frameByteLength(data);
    // `0` disables the check, the same convention `highWaterMarkBytes: 0` uses
    // in this class. The first draft took `min: 0` as "accepted" and documented
    // it as "no check", which is the opposite of what `size > 0` does for every
    // non-empty frame — so `0` meant *report everything*. Two spellings for one
    // idea, and the wrong one documented.
    if (this._maxPayloadSizeBytes > 0 && size > this._maxPayloadSizeBytes) {
      this._counters.oversizeFrames += 1;
      this._emit(
        'error',
        oversizedFrameError('PowerWebSocketClient', size, this._maxPayloadSizeBytes)
      );
    }

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
   * @param {{code?: number, reason?: string}} [event] The DOM `CloseEvent`,
   *   absent on a synthetic close.
   * @private
   */
  _handleClose(event) {
    this._clearHeartbeat();
    this._stopPoll();
    this._setPaused(false);
    this._writer = null;
    this._streamReader = null;
    this._state = READY_STATE.CLOSED;
    this._emit('close', event, this);
    // The reconnect run begins at the **outage**, not at the first retry, which
    // is what makes the elapsed budget mean what it says. A probe with a budget
    // of 0 still allowed one reconnect, because the clock was started lazily
    // inside `_scheduleReconnect` — so the first attempt was always free, and
    // "no time for even one retry" permitted exactly one. Starting it here means
    // a budget of 0 yields 0 attempts and 10s yields every retry inside 10s.
    if (!this._closedByUser) {
      // RT-014. **First, and ahead of every other input to the decision.**
      //
      // It sits here rather than inside `_scheduleReconnect` because the check
      // has to outrank *all* of them: `autoReconnect`, `maxReconnectAttempts` and
      // `maxReconnectElapsedMs` today, and a `shouldReconnect` callback whenever
      // one is added. A caller's own predicate must not be able to re-enable a
      // reconnect on a code that same caller just declared non-retryable — the
      // declaration is the stronger statement, and a callback that overrode it
      // would be a foot-gun with no way to notice it was firing.
      //
      // It also runs before `_reconnectStartedAt` is stamped, so a run that was
      // never started is not reported as one that began and stopped: the
      // elapsed budget stays `null` and the next `connect()` gets the full
      // window.
      if (matchesCloseCode(this._nonRetryableCloseCodes, event?.code)) {
        this._reconnectExhaustedBy = 'close-code';
        return;
      }
      if (this._reconnectStartedAt === null) this._reconnectStartedAt = nowMs();
      this._scheduleReconnect();
    }
  }

  /**
   * @param {any} err Whatever the platform or the caller reported. `any` because
   *   the WS `error` event carries no guaranteed shape.
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
    // RT-016. Shared with `PowerSocketAdapter` via `src/utils/liveness.js`, which is why
    // the guards and the deadline-only clear are unchanged from what RT-003 established
    // here: clearing `_heartbeatTimer` as well stopped the heartbeat after one round trip
    // (measured: 1 ping for the life of the socket against 28 in 150 ms), and a
    // backwards or `NaN` clock must not be recorded as an RTT.
    settleHeartbeatProbe({
      pingSentAt: this._pingSentAt,
      now: nowMs(),
      clearDeadline: () => {
        if (this._heartbeatDeadline) {
          clearTimeout(this._heartbeatDeadline);
          this._heartbeatDeadline = null;
        }
        this._pingSentAt = 0;
      },
      onHeartbeat: () => {
        this._counters.heartbeats += 1;
      },
      record: (rtt) => this.rtt.record(rtt),
    });
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
   * @param {boolean} paused
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
    // RT-016. Shared with `PowerSocketAdapter` via `src/utils/liveness.js`.
    //
    // **One behaviour changed here, and it was a decision rather than a merge.** This
    // used to report a throwing `ping()` and fall through to the arming, so a deadline
    // could be armed against a probe that had never gone out — and a deadline firing
    // with nothing outstanding reports a transport dead that may not be. The adapter
    // already did the safer thing. Both now arm only on a probe that was actually sent;
    // the reasoning is in that module's docblock so it can be argued with.
    sendHeartbeatProbe({
      canPing: Boolean(this._socket) && typeof this._socket.ping === 'function',
      now: nowMs(),
      ping: () => this._socket.ping(),
      onPingError: (e) => this._emit('error', e),
      markSent: (now) => {
        this._pingSentAt = now;
      },
      timeoutMs: this._heartbeatTimeoutMs,
      hasOutstanding: () => this._heartbeatDeadline !== null,
      arm: () => {
        this._heartbeatDeadline = setSafeTimeout(() => {
          this._heartbeatDeadline = null;
          this._onHeartbeatTimeout();
        }, this._heartbeatTimeoutMs);
      },
    });
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
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this._reconnectExhaustedBy = 'attempts';
      return;
    }
    // The elapsed bound. Checked *before* the attempt is counted, so an exhausted
    // clock does not inflate `reconnects` with an attempt that never happened.
    if (
      this._maxReconnectElapsedMs !== Number.POSITIVE_INFINITY &&
      this._reconnectStartedAt !== null &&
      nowMs() - this._reconnectStartedAt >= this._maxReconnectElapsedMs
    ) {
      this._reconnectExhaustedBy = 'elapsed';
      return;
    }
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
   * @param {string} type One of the keys of `this._on`.
   * @param {...any} args
   * @private
   */
  _emit(type, ...args) {
    const handler = /** @type {Record<string, (Function|null)|undefined>} */ (this._on)[type];
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
