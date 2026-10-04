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
export const FALLBACK_MAX_MESSAGE_SIZE_BYTES: number;
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
    constructor(channel: any, options?: PowerRTCChannelOptions);
    /** @type {any} The underlying channel, for escape hatches this class omits. */
    channel: any;
    _onMessage: ((arg0: {
        data: any;
        channel: import("./powerRTCChannel.js").PowerRTCChannel;
    }) => void) | null;
    _onOpen: ((arg0: import("./powerRTCChannel.js").PowerRTCChannel) => void) | null;
    _onClose: ((arg0: {
        reason: "local" | "remote";
        channel: import("./powerRTCChannel.js").PowerRTCChannel;
    }) => void) | null;
    _onError: ((arg0: any, arg1: import("./powerRTCChannel.js").PowerRTCChannel) => void) | null;
    _disposed: boolean;
    _closedByUs: boolean;
    /**
     * Everything this class attached to the caller's channel, so `dispose()` can
     * undo all of it. A listener nobody remembers to remove is the leak this
     * field exists to make impossible, and the listener count in
     * `test/powerRTCChannel.test.js` asserts it is back to zero — six on the way
     * in, which is what makes a seventh addition a deliberate edit.
     * @type {Array<[string, (any: any) => void]>}
     */
    _listeners: Array<[string, (any: any) => void]>;
    _state: number;
    _maxMessageSizeBytes: number;
    _highWaterMark: number;
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
    _backpressured: boolean;
    _counters: {
        messages: number;
        handled: number;
        bytesIn: number;
        sent: number;
        bytesOut: number;
        sendRefusals: number;
        sendFailures: number;
        oversizeFrames: number;
        backpressureEvents: number;
        lowBufferEvents: number;
        opened: number;
        closed: number;
    };
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
    /**
     * The channel's lifecycle state, as a numeric `READY_STATE`.
     *
     * The same numbers `PowerWebSocketClient` and `PowerSocketAdapter` report, for
     * the reason in the module docblock: the platform's own value is a string, and
     * comparing it to `READY_STATE` is always false.
     *
     * @returns {number}
     */
    get readyState(): number;
    /**
     * Whether the channel is open and this class has not been disposed.
     *
     * @returns {boolean}
     */
    get isOpen(): boolean;
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
    get bufferedAmount(): number;
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
    get isBackpressured(): boolean;
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
    get canPing(): boolean;
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
    send(frame: string | ArrayBuffer | ArrayBufferView): boolean;
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
    close(): void;
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
    stats(): object;
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
    getStats(): object;
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
    dispose(): void;
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
    private _attach;
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
    private _detachListeners;
    /**
     * @private
     * @param {any} data
     */
    private _handleMessage;
    /**
     * @private
     */
    private _handleClose;
    /**
     * Re-evaluate the high-water mark after a send.
     *
     * The platform increments `bufferedAmount` synchronously inside `send()`, so
     * reading it here is reading the state that send just created rather than a
     * value that will catch up later.
     *
     * @private
     */
    private _refreshBackpressure;
    /**
     * @private
     * @param {any} err
     */
    private _emitError;
    /**
     * @private
     * @param {any} fn
     * @param {any} arg
     */
    private _invoke;
    /**
     * Alias for {@link PowerRTCChannel#dispose}, so `using` works.
     */
    [Symbol.dispose](): void;
}
export default PowerRTCChannel;
export type PowerRTCChannelOptions = import("./jsdoc-types.js").PowerRTCChannelOptions;
