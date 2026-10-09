/**
 * PowerSequencer — gap detection and in-order reassembly for a datagram-style
 * transport.
 *
 * ## Why this exists
 *
 * A datagram transport gives you messages, not a stream. `RTCDataChannel` and
 * `WebTransport` datagrams can arrive **out of order**, and a caller that
 * assumes otherwise has two bad options: deliver whatever showed up and let the
 * application sort it out, or buffer everything and hope. The first corrupts
 * ordered state silently; the second grows without bound, because nothing in a
 * datagram tells you when to stop waiting.
 *
 * This class is the third option. It tracks a **window** of sequence numbers
 * starting at the next one it expects, buffers whatever arrives early, and
 * releases messages only when the gap in front of them has been filled. A gap
 * that never fills is *reported*, not waited on forever.
 *
 * ## What it deliberately does not do
 *
 * It does not retransmit, and it does not time out. Both need a clock and a
 * policy that belongs to the transport, not to a reassembler — a NACK interval
 * is a property of the link, and inventing one here would put a second,
 * contradictory retransmission policy in the library. What it does is make the
 * gap **visible**: `missing()` answers exactly which sequence numbers are being
 * waited on, and `onGap` fires the moment one appears, so the caller can decide
 * to NACK, to give up, or to keep waiting.
 *
 * The window is bounded by `windowSize`, so a peer that jumps ahead cannot make
 * this grow without limit — an out-of-window datagram is refused and counted
 * rather than buffered.
 *
 * @module powerSequencer
 * @public
 */
/**
 * @typedef {object} PowerSequencerOptions
 * @property {number} [windowSize=64] - How many sequence numbers ahead of the
 *   next expected one may be buffered. A datagram beyond the window is refused
 *   and counted in `stats().outOfWindow`, because buffering it would let a peer
 *   that jumped ahead grow this without limit.
 * @property {number} [startAt=0] - The first sequence number expected. Set it
 *   when the peer's numbering does not start at zero.
 * @property {(seq: number, missing: number[]) => void} [onGap] - Called when a
 *   datagram arrives above the next expected sequence, so a gap exists. Receives
 *   the sequence that opened it and the full list of numbers now being waited
 *   on. Fired once per *newly opened* gap, not once per datagram that arrives
 *   inside an existing one.
 * @property {(seq: number, payload: any) => void} [onMessage] - Called for each
 *   message released, in sequence order. A single `push()` can release several
 *   when it fills a gap that later datagrams were already waiting behind.
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] -
 *   Opt in to metrics. See `guides/metrics.md`.
 */
/**
 * In-order reassembly over an out-of-order datagram transport.
 *
 * Owns no timer and no listener registry — it is a pure state machine driven by
 * `push()`. So `dispose()` is a **state reset**, not a teardown: there is
 * nothing to cancel, and the interface exists so the helper can take part in
 * `using` / `await using` like every other long-lived helper here.
 *
 * @public
 * @example
 * const seq = new PowerSequencer({
 *   windowSize: 128,
 *   onGap: (s, missing) => sendNack(missing),
 *   onMessage: (s, payload) => handle(s, payload),
 * });
 *
 * channel.addEventListener('message', (e) => seq.push(e.seq, e.payload));
 */
export class PowerSequencer {
    /**
     * @param {number | PowerSequencerOptions} [options]
     */
    constructor(options?: number | PowerSequencerOptions);
    /** @type {Map<number, any>} */
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
    /**
     * The next sequence number that will be released.
     * @returns {number}
     */
    get nextExpected(): number;
    /**
     * Sequence numbers currently being waited on, ascending.
     *
     * This is the list a NACK would carry. It is derived from the buffer rather
     * than stored, so it cannot drift out of step with what is actually held.
     * @returns {number[]}
     */
    missing(): number[];
    /**
     * How many datagrams are buffered ahead of the gap.
     * @returns {number}
     */
    get buffered(): number;
    /**
     * Accept one datagram.
     *
     * @param {number} seq - The datagram's sequence number. Must be a finite
     *   integer; a fractional or non-finite value is refused rather than coerced,
     *   because `Math.floor` would silently renumber the stream.
     * @param {any} payload - The datagram's payload, handed to `onMessage` when
     *   the datagram is released.
     * @returns {boolean} Whether the datagram was accepted into the window. A
     *   duplicate or an out-of-window datagram returns `false` and is counted;
     *   neither is buffered.
     */
    push(seq: number, payload: any): boolean;
    /**
     * Release every message that is now contiguous, in order.
     *
     * A single `push()` that fills the gap can release several: the datagrams
     * that arrived early were buffered behind it, and they go out in one pass
     * rather than one per subsequent call.
     * @private
     * @returns {void}
     */
    /**
     * Discard all buffered state and resume from `startAt`.
     *
     * A state reset, not a teardown: this helper owns no timer and no listener
     * registry, so there is nothing to cancel. The interface exists so it can
     * take part in `using` / `await using` like every other long-lived helper
     * here.
     * @returns {void}
     */
    reset(): void;
    /**
     * Alias for {@link PowerSequencer#reset}.
     * @returns {void}
     */
    clear(): void;
    /**
     * @returns {void}
     */
    dispose(): void;
    /**
     * @returns {object} Counters. `delivered` is messages released in order,
     *   `duplicates` and `outOfWindow` are refusals, and `gapsOpened` counts
     *   distinct gaps rather than datagrams that arrived inside one.
     */
    stats(): object;
    /**
     * Alias for {@link PowerSequencer#stats}, matching the rest of the library.
     * @returns {object}
     */
    getStats(): object;
    [Symbol.dispose](): void;
    [Symbol.asyncDispose](): Promise<void>;
}
export default PowerSequencer;
export type PowerSequencerOptions = {
    /**
     * - How many sequence numbers ahead of the
     * next expected one may be buffered. A datagram beyond the window is refused
     * and counted in `stats().outOfWindow`, because buffering it would let a peer
     * that jumped ahead grow this without limit.
     */
    windowSize?: number | undefined;
    /**
     * - The first sequence number expected. Set it
     * when the peer's numbering does not start at zero.
     */
    startAt?: number | undefined;
    /**
     * - Called when a
     * datagram arrives above the next expected sequence, so a gap exists. Receives
     * the sequence that opened it and the full list of numbers now being waited
     * on. Fired once per *newly opened* gap, not once per datagram that arrives
     * inside an existing one.
     */
    onGap?: ((seq: number, missing: number[]) => void) | undefined;
    /**
     * - Called for each
     * message released, in sequence order. A single `push()` can release several
     * when it fills a gap that later datagrams were already waiting behind.
     */
    onMessage?: ((seq: number, payload: any) => void) | undefined;
    /**
     * -
     * Opt in to metrics. See `guides/metrics.md`.
     */
    observability?: boolean | import("./metrics.js").MetricsCollector | undefined;
};
