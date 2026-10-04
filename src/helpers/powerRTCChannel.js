/**
 * @typedef {import('./jsdoc-types.js').PowerRTCChannelOptions} PowerRTCChannelOptions
 */

/**
 * PowerRTCChannel — one `RTCDataChannel` behind the same shape as
 * `PowerSocketAdapter`, with the push back-pressure signal a WebSocket does not have.
 *
 * ## Why this exists, and what it deliberately is not
 *
 * It is **a transport adapter**, not a WebRTC stack. There is no
 * `RTCPeerConnection` here, no signalling, no ICE, no STUN/TURN — establishing a
 * data channel needs all four and none of them belong in a dependency-free
 * toolbox (the same reasoning REJ-007 gave for not shipping a WebSocket
 * *server*: RFC 6455 is a security liability to reimplement). You bring an open
 * — or opening — `RTCDataChannel`; this normalises it so the rest of your code
 * does not know it is not a socket.
 *
 * The three differences from a socket are the whole of the work:
 *
 * | | `WebSocket` | `RTCDataChannel` |
 * |---|---|---|
 * | `readyState` | number, `0`–`3` | **string**, `'connecting'`/`'open'`/`'closing'`/`'closed'` |
 * | oversize frame | buffers, then throws nothing | **`send()` throws** — SCTP caps one message |
 * | back-pressure | `bufferedAmount` polled on a backing-off timer | **`bufferedamountlow`, pushed** |
 *
 * ## The `readyState` trap is the reason the class exists
 *
 * `READY_STATE.OPEN` is `1`. A data channel's `readyState` is the string
 * `'open'`. So `channel.readyState === READY_STATE.OPEN` — the line every
 * caller in this library writes — is **false on a perfectly healthy open
 * channel**, with no error and no warning. Every "is it open?" guard silently
 * answers "no, forever", which for a hub adapter means `send()` refuses every
 * frame and `stats()` reports a channel that is connected and idle.
 *
 * That is the same failure the review calls a "silent total failure, reported as
 * a healthy connection", reached through a comparison rather than a missing
 * method. So this class reads the platform's string **once**, maps it to the
 * numeric `READY_STATE` the rest of the library uses, and maintains that copy
 * from events — never re-reading the platform per call.
 *
 * **Reading it once is not an optimisation, it is a requirement.** A channel
 * that has been transferred to another realm is *detached*, and getting
 * `readyState` on a detached channel throws `InvalidStateError`. A transferred
 * channel is exactly the case this class is meant to serve (see the guide), so
 * the initial read is guarded and every later read is the cached field.
 *
 * ## Back-pressure is a push signal here, which removes a timer
 *
 * `PowerWebSocketClient` needs `pollIntervalMs`, `maxPollIntervalMs` and
 * `lowWaterMarkBytes` — four options and a backing-off timer — to approximate a
 * low-water mark, because `WebSocket` has no event for it and a producer that
 * stops polling stops noticing the socket drain. A data channel **has** the
 * event: set `bufferedAmountLowThreshold` and the platform pushes
 * `bufferedamountlow` when the buffer falls back to it.
 *
 * So this class has exactly **one** watermark option, arms the platform's own
 * threshold with it, and exposes {@link isBackpressured} as a boolean read. No
 * timer, no poll interval, no second threshold, nothing to leak on `dispose()`.
 * The producer checks a flag; the flag stays accurate because the platform tells
 * us when to re-read.
 *
 * RT-017 recorded the `bufferedamountlow` half of this and did not mention the
 * timer it removes, which is the part a caller feels.
 *
 * ## What the row got right, and the three things it did not
 *
 * The row's premise claims were checked against MDN and the WebRTC 1.0 spec
 * before any of this was written, and two of the four held:
 *
 * - **`binaryType` is already `arraybuffer`.** True, and unlike `WebSocket`'s
 *   default of `"blob"`. This is why RT-002's fix is *not* repeated here: there
 *   is nothing to set. {@link PowerRTCChannel#stats} reports the live value so
 *   the property is checkable rather than assumed.
 * - **`RTCDataChannel` is transferable.** True, and baseline. The guide shows
 *   creating one on the main thread and `postMessage`-ing it into a worker.
 * - **`bufferedAmountLowThreshold` + `bufferedamountlow`.** True, and it is the
 *   reason this class is smaller than the client.
 * - **`ordered:false, maxRetransmits:0` gives UDP-like delivery.** True of the
 *   mechanism, but two corrections. The citation is wrong — RFC 8831 is *RTP
 *   media transport* and says nothing about data channels; the semantics are the
 *   WebRTC 1.0 spec's and the wire format is RFC 8841 (SCTP over DTLS). More
 *   importantly, **this class cannot deliver those semantics.** `ordered` and
 *   `maxRetransmits` are readable-only after `createDataChannel()`, so the
 *   choice is the caller's at creation time and nothing here can set it. A helper
 *   that reported "UDP-like" while quietly accepting the *default* reliable
 *   channel would be the exact class of silent defect this repository exists to
 *   prevent, so `expectUnreliable` makes the configuration a checked assertion
 *   instead, and `stats()` reports what the channel actually is.
 *
 * The omission that mattered most is the third one: **`send()` throws above the
 * SCTP message limit** (`OperationError`/`TypeError`), where a WebSocket buffers
 * and simply gets slower. On a hub adapter that is not a slow path, it is a lost
 * frame — see {@link PowerRTCChannel#send}.
 *
 * @module powerRTCChannel
 * @public
 */
import { attach, detach } from './metrics.js';
import { assertLimitRequired, assertKnownOptions } from '../utils/options.js';
import { frameByteLength } from '../utils/frameSize.js';
import { unsendableFrameError } from '../utils/errors.js';
import { READY_STATE } from './constants.js';

/**
 * The platform's string `readyState` values, mapped onto the numeric
 * `READY_STATE` every other helper in this library speaks.
 *
 * **This table is the class's reason for existing** — see the module docblock.
 * An unknown string maps to `CLOSING`, not `CLOSED`: a value this build has
 * never heard of is still a state the platform considers not-open, and
 * `send()` refuses in both. Mapping it to `CLOSED` would additionally trigger the
 * teardown paths, and mapping it to `OPEN` would defeat the guard entirely.
 *
 * @type {Readonly<Record<string, number>>}
 */
const RTC_READY_STATE = Object.freeze({
  connecting: READY_STATE.CONNECTING,
  open: READY_STATE.OPEN,
  closing: READY_STATE.CLOSING,
  closed: READY_STATE.CLOSED,
});

/**
 * Fallback message-size ceiling when the platform does not expose one.
 *
 * `RTCSctpTransport.maxMessageSize` is the real negotiated figure and is what
 * {@link PowerRTCChannelOptions.maxMessageSizeBytes} defaults to whenever the
 * platform reports it. When it does not — an older browser, a detached channel,
 * a test double — this is Chrome's value.
 *
 * **The direction of the error matters and this picks it deliberately.** Guessing
 * too *low* refuses frames the channel would have carried; guessing too *high*
 * lets `send()` throw, which this class catches and reports through `onError`.
 * So the fallback errs high, and the failure it can cause is a visible error
 * rather than a silent refusal.
 *
 * @type {number}
 */
export const FALLBACK_MAX_MESSAGE_SIZE_BYTES = 256 * 1024;

/**
 * PowerRTCChannel
 *
 * @class PowerRTCChannel
 * @public
 * @example
 * // Peer side. `dc` came from `pc.createDataChannel('hub', { ordered: false, maxRetransmits: 0 })`
 * // or from a `datachannel` event on the answering side.
 * const channel = new PowerRTCChannel(dc, {
 *   expectUnreliable: true,
 *   highWaterMarkBytes: 64 * 1024,
 *   onMessage: ({ data }) => handle(decodeMessage(data)),
 *   onClose: ({ reason }) => log.warn({ reason }, 'peer went away'),
 * });
 *
 * const hub = new PowerRealtimeHub({
 *   send: (sub, frame) => sub.transport.send(frame),
 *   close: (sub) => sub.transport.close(),
 *   onError: (err) => log.error({ err }, 'send failed'),
 * });
 * hub.subscribe('ticks', onTick, { transport: channel });
 */
export class PowerRTCChannel {
  /**
   * @param {any} channel - An `RTCDataChannel`, or anything with its shape. It
   *   may still be `connecting`: `send()` refuses until `open`, and `onOpen`
   *   reports when that changes.
   * @param {PowerRTCChannelOptions} [options]
   */
  constructor(channel, options = /** @type {PowerRTCChannelOptions} */ ({})) {
    assertKnownOptions(
      options,
      [
        'observability',
        'onMessage',
        'onOpen',
        'onClose',
        'onError',
        'highWaterMarkBytes',
        'maxMessageSizeBytes',
        'expectUnreliable',
      ],
      'PowerRTCChannel'
    );
    const {
      onMessage,
      onOpen,
      onClose,
      onError,
      highWaterMarkBytes = 64 * 1024,
      maxMessageSizeBytes,
      expectUnreliable = false,
    } = options || {};

    if (!channel || typeof channel !== 'object' || typeof channel.send !== 'function') {
      throw new TypeError(
        'PowerRTCChannel: expected an RTCDataChannel. It needs a `send(data)` method; ' +
          'pass the channel itself, not the RTCPeerConnection that created it.'
      );
    }

    // **Checked before anything is attached or mutated**, so a rejected
    // configuration cannot leave a listener installed or a threshold written on
    // the caller's object. `detectSocketKind` refuses an unrecognised socket the
    // same way, and for the same reason: an unrecognised transport stored as-is
    // matches no branch and reports itself healthy.
    if (expectUnreliable && (channel.ordered !== false || channel.maxRetransmits !== 0)) {
      throw new TypeError(
        'PowerRTCChannel: `expectUnreliable` was set, but this channel is ' +
          `ordered=${String(channel.ordered)} maxRetransmits=${String(channel.maxRetransmits)}. ` +
          'UDP-like delivery needs `pc.createDataChannel(label, { ordered: false, maxRetransmits: 0 })`, ' +
          'and those are fixed at creation — this class cannot set them. Either pass that init, ' +
          'or drop `expectUnreliable` and read `stats().ordered` to find out at runtime.'
      );
    }

    /** @type {any} The underlying channel, for escape hatches this class omits. */
    this.channel = channel;
    this._onMessage = onMessage || null;
    this._onOpen = onOpen || null;
    this._onClose = onClose || null;
    this._onError = onError || null;
    this._disposed = false;
    this._closedByUs = false;
    /**
     * Everything this class attached to the caller's channel, so `dispose()` can
     * undo all of it. A listener nobody remembers to remove is the leak this
     * field exists to make impossible, and the listener count in
     * `test/powerRTCChannel.test.js` asserts it is back to zero — six on the way
     * in, which is what makes a seventh addition a deliberate edit.
     * @type {Array<[string, (any: any) => void]>}
     */
    this._listeners = [];

    // Read once, guarded. A **detached** channel — one transferred to another
    // realm — throws `InvalidStateError` on `readyState`, and a detached channel
    // is the case the guide's worker section is about. So the read cannot be the
    // thing that fails construction; an unreadable state is reported as
    // `CONNECTING` because the only honest statement about it is that it is not
    // open. Every later read is this field, never the platform.
    this._state = READY_STATE.CONNECTING;
    try {
      this._state = RTC_READY_STATE[channel.readyState] ?? READY_STATE.CLOSING;
    } catch {
      /* a detached channel: not open, and the events will say more */
    }

    this._maxMessageSizeBytes = assertLimitRequired(maxMessageSizeBytes, {
      name: 'maxMessageSizeBytes',
      className: 'PowerRTCChannel',
      min: 0,
      // `Infinity` is a legitimate "delegate the check to the platform", which
      // is why `allowInfinity` is set here where it is not on the other two
      // helpers' equivalent option. Those describe an *inbound* limit on frames
      // the platform has already accepted; this one describes an outbound limit
      // the platform enforces itself, with a throw. Turning the check off means
      // accepting that throw.
      allowInfinity: true,
      fallback: readSctpMaxMessageSize(channel),
    });

    this._highWaterMark = assertLimitRequired(highWaterMarkBytes, {
      name: 'highWaterMarkBytes',
      className: 'PowerRTCChannel',
      min: 0,
      fallback: 64 * 1024,
    });

    /**
     * Whether the outgoing buffer is above the high-water mark.
     *
     * **Set from the send path, cleared from the event**, which is what makes it
     * accurate without a timer: `send()` is the only thing that raises the
     * buffer, and `bufferedamountlow` is the only thing that lowers it. Reading
     * `bufferedAmount > mark` on each send covers the raise; the event covers the
     * fall. Polling on a timer would answer the same question later and cost a
     * wakeup for it.
     */
    this._backpressured = false;

    this._counters = {
      // Inbound frames that arrived, versus those actually handed on. A gap means
      // a message with no `onMessage` — the same reason `PowerSocketAdapter`
      // separates `messages` from `handled`.
      messages: 0,
      handled: 0,
      bytesIn: 0,
      // Outbound frames accepted by `send()`. Frames refused because the channel
      // was not open are counted separately: "the channel was not ready" is the
      // producer's problem to retry, and folding it into `sendFailures` would
      // make a connect race indistinguishable from a broken transport.
      sent: 0,
      bytesOut: 0,
      sendRefusals: 0,
      sendFailures: 0,
      // **Refused before `send()`, so the platform never saw them.** Distinct
      // from `sendFailures`, which are the platform's own throws.
      oversizeFrames: 0,
      // Transitions into the back-pressured state, not sends made while over the
      // mark — see `_refreshBackpressure`.
      backpressureEvents: 0,
      // The push signal firing. Exposed because a producer that never checks
      // `isBackpressured` should still be able to see that the signal works.
      lowBufferEvents: 0,
      opened: 0,
      closed: 0,
    };

    this._attach();

    // **Only when the watermark is in use.** `bufferedAmountLowThreshold` defaults
    // to 0, and a threshold of 0 makes `bufferedamountlow` fire whenever the
    // buffer reaches 0 — so "disable the watermark" implemented as "write 0" would
    // turn the event into a metronome. `highWaterMarkBytes: 0` disables, matching
    // every other limit in this library.
    if (this._highWaterMark > 0) {
      try {
        channel.bufferedAmountLowThreshold = this._highWaterMark;
      } catch (e) {
        this._emitError(e);
      }
    }

    // A channel handed over already open never fires `open`, so the caller's
    // `onOpen` would never run. Reported once, from the state already read above,
    // and counted so `stats().opened` means "reported open" rather than "the
    // event arrived" — the two differ for exactly this channel.
    if (this._state === READY_STATE.OPEN) {
      this._counters.opened += 1;
      this._invoke(this._onOpen, { channel: this });
    }

    // FEAT-007: opt-in metrics. Off by default, so the common case pays nothing.
    this._metrics = attach(this, 'rtc', options);
  }

  /**
   * The channel's lifecycle state, as a numeric `READY_STATE`.
   *
   * The same numbers `PowerWebSocketClient` and `PowerSocketAdapter` report, for
   * the reason in the module docblock: the platform's own value is a string, and
   * comparing it to `READY_STATE` is always false.
   *
   * @returns {number}
   */
  get readyState() {
    return this._state;
  }

  /**
   * Whether the channel is open and this class has not been disposed.
   *
   * @returns {boolean}
   */
  get isOpen() {
    return this._state === READY_STATE.OPEN && !this._disposed;
  }

  /**
   * Bytes buffered by the transport for sending.
   *
   * **`0` unless the channel is open** — the RT-018 trap, and it applies here
   * unchanged. A buffered-amount number that never comes back down turns a
   * producer's watermark wait into a spin: every check keeps failing and nothing
   * reports why. MDN documents the behaviour on `WebSocket.bufferedAmount`, and
   * `RTCSctpTransport.bufferedAmount` is the same shape of number with the same
   * "queued to be sent" meaning, so a caller writing the naive loop against this
   * class would hang on a closed channel for the same reason.
   *
   * A non-numeric value is coerced to `0` rather than propagated. `NaN` compares
   * false against every watermark, so a proxy or a double reporting a string
   * would read as *never backed up* and silently defeat back-pressure — the
   * quieter and worse direction.
   *
   * @returns {number}
   */
  get bufferedAmount() {
    if (this._disposed || !this.channel) return 0;
    if (this._state !== READY_STATE.OPEN) return 0;
    const n = Number(this.channel.bufferedAmount);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Whether a producer should pause.
   *
   * The push-signal answer: no poll timer, no backing off, and it cannot be
   * forgotten by a caller who stopped checking a timer.
   *
   * ```js
   * while (messages.length && !channel.isBackpressured) channel.send(messages.shift());
   * ```
   *
   * `false` forever when `highWaterMarkBytes` is `0`, which is what disabling the
   * watermark means.
   *
   * @returns {boolean}
   */
  get isBackpressured() {
    return this._backpressured;
  }

  /**
   * Whether the transport exposes a usable probe.
   *
   * Always `false`, and reported rather than omitted. There is no protocol-level
   * ping on a data channel — nothing answers one, because there is no framing
   * layer beneath it to define one — so liveness here is the `close` event plus
   * message activity. RT-003 established that a transport which cannot measure
   * must say "unmeasured" rather than report `0 ms`, and a helper that reported
   * no RTT field at all would leave a caller comparing it against a sibling
   * helper's `rtt` with nothing to compare.
   *
   * @returns {boolean}
   */
  get canPing() {
    return false;
  }

  /**
   * Send one frame.
   *
   * **Two refusals, and they are not the same thing.** This is the whole design
   * decision on this method, so it is worth being explicit:
   *
   * - **Not open → `false`.** Transient. The caller retries. This matches
   *   `PowerSocketAdapter.send`, whose documented contract is "false means not
   *   now", and it is the guard that keeps a `connecting` channel from throwing
   *   `InvalidStateError` out of {@link send}.
   *
   *   **A hub cannot see it.** `PowerRealtimeHub` increments `delivered` *before*
   *   calling a `send(sub, frame)` adapter and invokes the subscriber's handler
   *   on the success path of whatever the adapter returned — so a `false` is not
   *   a rejection, and the consumer is told it processed a frame that never left
   *   the process. `PowerSocketAdapter` has the same property. The only trace is
   *   `stats().sendRefusals`, so if a caller is wiring this straight into a hub
   *   they must watch it; the guide says so and
   *   `test/powerRTCChannel.hub.test.js` pins it.
   * - **Over the message-size ceiling → `throw`.** Permanent. No amount of
   *   retrying makes an oversized frame small, so a caller looping on `false`
   *   would spin on it forever. Throwing is also the only thing a hub can
   *   observe: it routes a throw to `onError` and leaves `delivered` uncounted
   *   for that batch, whereas a `false` would lose the frame with `delivered`
   *   already incremented. So the throw is not a stricter contract for its own
   *   sake — it is the only outcome that reaches anyone.
   *
   * The frame is handed to the platform **without a copy**, which is safe because
   * `RTCDataChannel.send()` serialises synchronously — the same guarantee
   * `WebSocket.send()` gives. It matters because `PowerRealtimeHub` hands every
   * subscriber of a topic **the same buffer** (its RT-006 encode memo), so a
   * transport that wrote into the frame would corrupt every other subscriber. A
   * transport that *retains* the frame past the call — a stream writer, for
   * instance — must copy it.
   *
   * @param {string|ArrayBuffer|ArrayBufferView} frame
   * @returns {boolean} `false` when the channel is not open. Throws only for a
   *   frame this channel can never carry.
   */
  send(frame) {
    if (this._disposed) return false;
    if (this._state !== READY_STATE.OPEN) {
      this._counters.sendRefusals += 1;
      return false;
    }
    const size = frameByteLength(frame);
    if (this._maxMessageSizeBytes > 0 && size > this._maxMessageSizeBytes) {
      // Counted, then thrown. Without the counter this is the one refusal with
      // no number behind it, and the throw alone says a *message* went wrong
      // rather than a payload size — which is the thing to alert on.
      this._counters.oversizeFrames += 1;
      throw unsendableFrameError('PowerRTCChannel', size, this._maxMessageSizeBytes);
    }
    try {
      this.channel.send(frame);
    } catch (e) {
      this._counters.sendFailures += 1;
      this._emitError(e);
      return false;
    }
    this._counters.sent += 1;
    this._counters.bytesOut += size;
    this._refreshBackpressure();
    return true;
  }

  /**
   * Close the channel.
   *
   * **No code and no reason.** `RTCDataChannel.close()` takes no arguments, and
   * the `close` event carries neither — unlike `WebSocket`, which hands you a
   * `CloseEvent` with both. A `PowerRealtimeHub` `close(sub, reason)` adapter
   * therefore has to take its reason from its own argument; the hub supplies
   * `'unsubscribe'`, `'slow-consumer'` or `'hub-closed'` and that string is the
   * only record of why, so pass it to your own logging there.
   *
   * Safe to call more than once, and safe on a channel that closed first.
   *
   * @returns {void}
   */
  close() {
    if (this._disposed || this._state === READY_STATE.CLOSED) return;
    this._closedByUs = true;
    try {
      this.channel?.close?.();
    } catch (e) {
      this._emitError(e);
    }
    // Set here as well as from the `close` event, for the reason
    // `PowerSocketAdapter.close` sets its own: the local path must stop
    // `isOpen` immediately rather than waiting for an event the peer may never
    // cause to fire.
    this._handleClose();
  }

  /**
   * Counters, the channel's configured reliability, and the live transport state.
   *
   * `ordered` / `maxRetransmits` / `maxPacketLifeTime` are reported because this
   * class cannot set them (they are fixed by `createDataChannel()`), which makes
   * "what am I actually getting" a question only a runtime read can answer. A
   * dashboard can alert on `ordered === false && maxRetransmits === 0` and catch
   * a peer that negotiated a different channel than the application believes it
   * asked for.
   *
   * @returns {object}
   */
  stats() {
    return {
      ...this._counters,
      state: this._state,
      isBackpressured: this._backpressured,
      bufferedAmount: this.bufferedAmount,
      // RT-017's premise, made checkable. Read live rather than cached at
      // construction: a caller may replace the channel's fields, and a stale copy
      // in `stats()` is the one number here that could report a reliability the
      // transport no longer has.
      ordered: this.channel?.ordered,
      maxRetransmits: this.channel?.maxRetransmits,
      maxPacketLifeTime: this.channel?.maxPacketLifeTime ?? null,
      // Verified `arraybuffer` by default, unlike `WebSocket`. Reported because
      // "we checked once" is not a guarantee about the caller's channel, and a
      // `blob` here means every inbound frame is a `Blob` — which is RT-002's
      // defect, on a transport that did not ask for it.
      binaryType: this.channel?.binaryType ?? null,
      maxMessageSizeBytes: this._maxMessageSizeBytes,
      highWaterMarkBytes: this._highWaterMark,
      canPing: this.canPing,
    };
  }

  /**
   * Alias for {@link stats}, so a caller who learned `getStats()` from
   * `PowerPool` — the one class that has always spelled it this way — is not
   * handed `TypeError: x.getStats is not a function` here.
   *
   * Written out per class rather than installed on the prototype: a dynamic
   * `Object.defineProperty` is invisible to `tsc`, so the generated `types/`
   * omitted it and a TypeScript caller got a type error on a method that worked
   * at runtime. `test/statsNaming.test.js` pins the descriptor being present.
   */
  getStats() {
    return this.stats();
  }

  /**
   * Detach every listener and drop the caller's channel reference.
   *
   * Required rather than tidy, for the reason `PowerSocketAdapter.dispose` is:
   * an `RTCDataChannel` outliving its adapter keeps every handler closure alive,
   * and a peer table that never disposes leaks one adapter per peer for the life
   * of the page. `dispose()` also **closes** the channel — an adapter that
   * detached from a still-open channel leaves a transport nobody is reading.
   *
   * `dispose()` is idempotent and does **not** null the caller's callbacks'
   * closures' targets beyond this object, but it does null its own handler
   * fields, so a message already in flight cannot reach a torn-down adapter.
   *
   * @returns {void}
   */
  dispose() {
    detach(this._metrics);
    this._metrics = null;
    if (this._disposed) return;
    this._disposed = true;
    this.close();
    this._detachListeners();
    this._state = READY_STATE.CLOSED;
    this._backpressured = false;
    this._onMessage = null;
    this._onOpen = null;
    this._onClose = null;
    this._onError = null;
    this.channel = null;
  }

  /**
   * Alias for {@link PowerRTCChannel#dispose}, so `using` works.
   */
  [Symbol.dispose]() {
    this.dispose();
  }

  /**
   * Subscribe to the six events this class needs, and record how to undo it.
   *
   * `addEventListener` rather than the `onopen`/`onmessage` properties: the
   * `on*` form **overwrites** whatever the caller had already assigned, so
   * adopting a caller's channel would silently disable their own handlers. A
   * `WebSocket` would behave the same way, and `PowerSocketAdapter` uses
   * `addEventListener` for exactly this reason.
   *
   * **`closing` is one of the six and not an optional extra.** The module
   * docblock lists `closing` as one of the four states being normalised, and
   * omitting the event meant a channel in that state reported `OPEN` — the exact
   * "reports itself healthy" failure the class exists to prevent. The platform
   * throws `InvalidStateError` from `send()` while `closing`, so the frame did
   * not vanish, but every frame during a teardown produced a spurious
   * `onError`, and `stats().state` lied for the whole of it.
   *
   * @private
   */
  _attach() {
    const onOpen = () => {
      // **`close` is terminal, so this must not resurrect.** The property test
      // `keeps every counter non-negative` found this by firing `close` then
      // `open`: the channel went back to open, `close` fired a second time, and
      // `stats().closed` read 2 for one closure. A data channel has no reopen
      // path — a transport that recovers produces a *new* channel — so an `open`
      // arriving after `close` is a late delivery of an event already
      // overtaken, not a state change. Counting it would make `closed` and
      // `opened` lie in the one direction a peer table acts on.
      if (this._state === READY_STATE.CLOSED) return;
      this._state = READY_STATE.OPEN;
      this._counters.opened += 1;
      this._invoke(this._onOpen, { channel: this });
    };
    const onMessage = (/** @type {any} */ e) => this._handleMessage(e?.data);
    // Tracked but not reported as a close. `closing` means the transport is
    // *about* to go, so the channel is already unusable for `send()` — refusing
    // there is the point — but it is not closed yet and `onClose` must not fire
    // until it is. Firing it early would tear a peer down before the close
    // handshake finished.
    const onClosing = () => {
      if (this._state !== READY_STATE.OPEN) return;
      this._state = READY_STATE.CLOSING;
    };
    const onClose = () => this._handleClose();
    const onError = (/** @type {any} */ e) => this._emitError(e?.error ?? e);
    // **The push signal, and the only thing that clears the flag.** No comparison
    // and no re-read of the threshold: the platform has already told us the
    // buffer is back at or below the watermark we gave it.
    const onBufferLow = () => {
      this._counters.lowBufferEvents += 1;
      this._backpressured = false;
    };
    /** @type {Array<[string, (any: any) => void]>} */
    const listeners = [
      ['open', onOpen],
      ['message', onMessage],
      ['closing', onClosing],
      ['close', onClose],
      ['error', onError],
      ['bufferedamountlow', onBufferLow],
    ];
    // **No second `@type` comment here.** Typedoc warns when a field carries a
    // doc comment in two places and then picks one arbitrarily, so the type is
    // declared once — on the constructor's field, which is also the assignment
    // `tsc` reads.
    this._listeners = listeners;
    for (const [type, fn] of listeners) {
      try {
        this.channel.addEventListener(type, fn);
      } catch (e) {
        this._emitError(e);
      }
    }
  }

  /**
   * Remove everything {@link PowerRTCChannel#_attach} added.
   *
   * One method rather than a `dispose()` that remembers each type, for the
   * reason `PowerSocketAdapter._detachListeners` is one: the list is the same
   * object both sides walk, so a listener added in one place and not the other
   * is a compile-order accident waiting to happen.
   *
   * @private
   */
  _detachListeners() {
    const channel = this.channel;
    if (!channel || typeof channel.removeEventListener !== 'function') return;
    for (const [type, fn] of this._listeners) {
      try {
        channel.removeEventListener(type, fn);
      } catch {
        /* a channel that refuses to detach must not block disposal */
      }
    }
    this._listeners = [];
  }

  /**
   * @private
   * @param {any} data
   */
  _handleMessage(data) {
    if (this._disposed) return;
    this._counters.messages += 1;
    this._counters.bytesIn += frameByteLength(data);
    if (!this._onMessage) return;
    // `close` is **terminal** for a data channel: there is no reopen, and a
    // transferred channel's own event stream is gone. So a `message` that
    // arrives anyway — from a `close` the platform delivered late relative to a
    // queued message — is counted but not handed on, and this class does not move
    // a closed channel back to anything else.
    if (this._state === READY_STATE.CLOSED) return;
    this._counters.handled += 1;
    this._invoke(this._onMessage, { data, channel: this });
  }

  /**
   * @private
   */
  _handleClose() {
    if (this._state === READY_STATE.CLOSED) return;
    this._state = READY_STATE.CLOSED;
    this._counters.closed += 1;
    // **Cleared here, and the reason is RT-018 one level down.** RT-018 found
    // that a `bufferedAmount` never comes back down after a close, so a producer
    // waiting on it spins forever. The `bufferedAmount` gate handles the number;
    // this handles the *flag*, which is derived from that number and would
    // otherwise stay `true` for the rest of the channel's life with no event
    // coming to correct it. A stranded buffer must not become a permanent stall.
    this._backpressured = false;
    // **Why it was closed is not knowable from the platform**, so this reports
    // what this class knows: whether *we* asked. `'remote'` covers a peer that
    // vanished, an ICE drop, and a `close()` from the other side — all of which
    // arrive as one bare `close` event with no code and no reason.
    this._invoke(this._onClose, {
      reason: this._closedByUs ? 'local' : 'remote',
      channel: this,
    });
  }

  /**
   * Re-evaluate the high-water mark after a send.
   *
   * The platform increments `bufferedAmount` synchronously inside `send()`, so
   * reading it here is reading the state that send just created rather than a
   * value that will catch up later.
   *
   * @private
   */
  _refreshBackpressure() {
    if (this._highWaterMark <= 0) return;
    const was = this._backpressured;
    this._backpressured = this.bufferedAmount > this._highWaterMark;
    // Counted on the **transition**, not per send, so the number answers "how
    // often did this channel back up" rather than "how many frames did it send
    // while over the mark" — which is the send count again, and would make the
    // two agree for no reason.
    if (this._backpressured && !was) this._counters.backpressureEvents += 1;
  }

  /**
   * @private
   * @param {any} err
   */
  _emitError(err) {
    if (typeof this._onError === 'function') {
      try {
        this._onError(err, this);
      } catch {
        /* a throwing error handler must not become an unhandled rejection */
      }
    }
  }

  /**
   * @private
   * @param {any} fn
   * @param {any} arg
   */
  _invoke(fn, arg) {
    if (typeof fn !== 'function') return;
    try {
      fn(arg);
    } catch (e) {
      this._emitError(e);
    }
  }
}

/**
 * The negotiated SCTP message-size ceiling, or the documented fallback.
 *
 * Read through `channel.sctp` rather than off the channel itself: it is
 * `RTCSctpTransport.maxMessageSize`, and a channel whose transport is not
 * exposed — a double in a test, a platform that has not settled the association
 * yet — simply has none. Every read is guarded, because `sctp` is absent on some
 * implementations and throwing here would make the constructor unusable on
 * exactly the channels a caller is most likely to hand over mid-negotiation.
 *
 * @param {any} channel
 * @returns {number}
 */
function readSctpMaxMessageSize(channel) {
  try {
    const n = Number(channel?.sctp?.maxMessageSize);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* a detached transport, or one that has not been created yet */
  }
  return FALLBACK_MAX_MESSAGE_SIZE_BYTES;
}

export default PowerRTCChannel;
