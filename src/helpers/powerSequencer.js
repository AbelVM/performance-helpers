import { attach, detach } from './metrics.js';
import { assertLimitRequired, assertKnownOptions } from '../utils/options.js';

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
  constructor(options = {}) {
    /** @type {PowerSequencerOptions} */
    let opts = /** @type {any} */ (options);
    if (typeof options === 'number') {
      opts = { windowSize: options };
    }
    assertKnownOptions(
      opts,
      ['windowSize', 'startAt', 'onGap', 'onMessage', 'observability'],
      'PowerSequencer'
    );
    const windowSize = assertLimitRequired(opts.windowSize, {
      name: 'windowSize',
      className: 'PowerSequencer',
      min: 1,
      fallback: 64,
    });
    const startAt = assertLimitRequired(opts.startAt, {
      name: 'startAt',
      className: 'PowerSequencer',
      min: 0,
      integer: true,
      fallback: 0,
    });
    this._windowSize = windowSize;
    // Kept so `reset()` can resume from where the caller said the stream
    // starts. Without it a reset would restart at 0 on a peer whose numbering
    // began elsewhere, and every message would then read as out-of-window.
    this._startAt = startAt;
    this._onGap = typeof opts.onGap === 'function' ? opts.onGap : null;
    this._onMessage = typeof opts.onMessage === 'function' ? opts.onMessage : null;
    /** @type {Map<number, any>} */
    this._buffer = new Map();
    this._next = startAt;
    this._disposed = false;
    this._delivered = 0;
    this._duplicates = 0;
    this._outOfWindow = 0;
    this._gapsOpened = 0;
    this._metrics = attach(this, 'sequencer', opts);
  }

  /**
   * The next sequence number that will be released.
   * @returns {number}
   */
  get nextExpected() {
    return this._next;
  }

  /**
   * Sequence numbers currently being waited on, ascending.
   *
   * This is the list a NACK would carry. It is derived from the buffer rather
   * than stored, so it cannot drift out of step with what is actually held.
   * @returns {number[]}
   */
  missing() {
    const out = [];
    for (let seq = this._next; ; seq++) {
      if (!this._buffer.has(seq)) {
        out.push(seq);
        // The first absent number ends the run: everything above it is either
        // buffered (so not missing) or beyond the window (so not waited on).
        break;
      }
    }
    return out;
  }

  /**
   * How many datagrams are buffered ahead of the gap.
   * @returns {number}
   */
  get buffered() {
    return this._buffer.size;
  }

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
  push(seq, payload) {
    if (this._disposed) return false;
    const n = Number(seq);
    if (!Number.isInteger(n)) {
      throw new TypeError(
        'PowerSequencer: `seq` must be an integer (received ' +
          `${String(seq)}). A fractional sequence number would be renumbered by any ` +
          'floor, silently shifting every message after it.'
      );
    }
    // Already released. Counted rather than ignored: a peer retransmitting is
    // normal on a lossy link, and a duplicate rate that climbs is the signal
    // that the NACK path is misbehaving.
    if (n < this._next) {
      this._duplicates += 1;
      return false;
    }
    // Beyond the window. Refused rather than buffered, so a peer that jumped
    // ahead — or a peer whose numbering restarted — cannot grow this without
    // limit.
    if (n >= this._next + this._windowSize) {
      this._outOfWindow += 1;
      return false;
    }
    if (this._buffer.has(n)) {
      this._duplicates += 1;
      return false;
    }
    const wasContiguous = n === this._next;
    // A gap is "buffered datagrams above `next`, with `next` itself absent" —
    // not merely "`next` is absent", because an empty buffer is waiting for the
    // next datagram rather than holding a hole open. Getting this wrong fired
    // `onGap` on every non-contiguous arrival, so one gap became a storm of
    // callbacks and `gapsOpened` counted datagrams instead of gaps.
    const hadGap = this._buffer.size > 0 && !this._buffer.has(this._next);
    this._buffer.set(n, payload);
    const hasGap = this._buffer.size > 0 && !this._buffer.has(this._next);
    // Counted whether or not a handler is registered. `gapsOpened` is a stat a
    // caller alerts on, and folding it into the `&& this._onGap` guard made it
    // read 0 for every sequencer built without a callback — which is most of
    // them, since the callback is the opt-in half.
    if (!wasContiguous && !hadGap && hasGap) {
      this._gapsOpened += 1;
      if (this._onGap) {
        try {
          this._onGap(n, this.missing());
        } catch {
          // A throwing gap handler must not stop the datagram being accepted.
          // The buffer is the reassembler's state; refusing the push because a
          // callback threw would lose data the caller can still recover by NACK.
        }
      }
    }
    if (wasContiguous) this._release();
    return true;
  }

  /**
   * Release every message that is now contiguous, in order.
   *
   * A single `push()` that fills the gap can release several: the datagrams
   * that arrived early were buffered behind it, and they go out in one pass
   * rather than one per subsequent call.
   * @private
   * @returns {void}
   */
  _release() {
    for (;;) {
      if (!this._buffer.has(this._next)) return;
      const payload = this._buffer.get(this._next);
      this._buffer.delete(this._next);
      this._next += 1;
      this._delivered += 1;
      if (this._onMessage) {
        try {
          this._onMessage(this._next - 1, payload);
        } catch {
          // A throwing handler must not stop the release. The messages behind
          // it are already contiguous, and abandoning the walk would leave them
          // buffered forever behind a gap that no longer exists — the caller
          // would see a permanent stall with `missing()` reporting nothing.
        }
      }
    }
  }

  /**
   * Discard all buffered state and resume from `startAt`.
   *
   * A state reset, not a teardown: this helper owns no timer and no listener
   * registry, so there is nothing to cancel. The interface exists so it can
   * take part in `using` / `await using` like every other long-lived helper
   * here.
   * @returns {void}
   */
  reset() {
    this._buffer.clear();
    this._next = this._startAt;
    this._delivered = 0;
    this._duplicates = 0;
    this._outOfWindow = 0;
    this._gapsOpened = 0;
  }

  /**
   * Alias for {@link PowerSequencer#reset}.
   * @returns {void}
   */
  clear() {
    this.reset();
  }

  /**
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    detach(this._metrics);
    this._metrics = null;
    this._buffer.clear();
    this._onGap = null;
    this._onMessage = null;
  }

  [Symbol.dispose]() {
    this.dispose();
  }

  async [Symbol.asyncDispose]() {
    this.dispose();
    return;
  }

  /**
   * @returns {object} Counters. `delivered` is messages released in order,
   *   `duplicates` and `outOfWindow` are refusals, and `gapsOpened` counts
   *   distinct gaps rather than datagrams that arrived inside one.
   */
  stats() {
    return {
      nextExpected: this._next,
      buffered: this._buffer.size,
      missing: this.missing().length,
      delivered: this._delivered,
      duplicates: this._duplicates,
      outOfWindow: this._outOfWindow,
      gapsOpened: this._gapsOpened,
      windowSize: this._windowSize,
    };
  }

  /**
   * Alias for {@link PowerSequencer#stats}, matching the rest of the library.
   * @returns {object}
   */
  getStats() {
    return this.stats();
  }
}

export default PowerSequencer;
