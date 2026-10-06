/**
 * PowerDatagramChannel — a bounded, drop-counting wrapper for a datagram-style
 * transport (e.g. `RTCDataChannel`, `WebTransport` datagram stream).
 *
 * ## Why this exists
 *
 * The hub's `send(sub, frame)` adapter contract assumes a transport that either
 * accepts a frame or refuses it permanently. Datagram transports do not fit that
 * shape: they have a *message-size ceiling* enforced by the platform, and when a
 * datagram exceeds it the platform either **throws** (`RTCDataChannel`) or
 * **silently discards** it with no signal to the sender.
 *
 * The silent-discard case is the dangerous one. A caller that never learns a
 * datagram was dropped has no way to count the loss, and a hub that cannot count
 * drops cannot honour its slow-consumer contract. This class exists to make the
 * refusal **loud and countable**.
 *
 * ## What this is not
 *
 * This is **not** a `PowerRealtimeHub` `send(sub, frame)` adapter. The hub's
 * `retain` feature and datagrams contradict each other: a retained message is a
 * framed JSON payload, while a datagram is an unframed binary blob. Wrapping a
 * datagram channel in a hub adapter would silently drop the `retain` guarantee
 * every time the platform discards an oversize datagram.
 *
 * Use this class directly when you need bounded, counted datagram delivery, or
 * wrap it in your own adapter that knows how to frame and retain.
 *
 * ## The hard size check
 *
 * `maxDatagramSizeBytes` is enforced **before** the platform sees the datagram.
 * An oversize datagram is refused with a `TypeError`, counted in
 * `stats().oversizeDatagrams`, and never handed to the underlying transport.
 * This is the opposite of the platform's silent-discard behaviour, and it is
 * the whole point of the class.
 *
 * @module powerDatagramChannel
 * @public
 */
import { attach, detach } from './metrics.js';
import { assertLimitRequired, assertKnownOptions } from '../utils/options.js';
import { frameByteLength } from '../utils/frameSize.js';

/**
 * @typedef {object} PowerDatagramChannelOptions
 * @property {function(Error, object):void} [onError] - Called when the
 *   underlying transport throws or when an oversize datagram is refused.
 * @property {number} [maxDatagramSizeBytes=65535] - Hard ceiling on outbound
 *   datagram size. A datagram larger than this is refused with a `TypeError`
 *   before it reaches the transport. `0` disables the check.
 * @property {number} [maxQueue=64] - Maximum datagrams buffered for sending
 *   when the transport is not ready. `0` disables queueing: a datagram arriving
 *   while the transport is closed is refused immediately.
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] -
 *   Opt in to metrics. See `guides/metrics.md`.
 */

/**
 * A bounded, drop-counting datagram channel.
 *
 * @public
 * @example
 * const channel = new PowerDatagramChannel(transport, {
 *   maxDatagramSizeBytes: 64 * 1024,
 *   maxQueue: 128,
 *   onError: (err, ctx) => log.warn({ err, ctx }, 'datagram refused'),
 * });
 *
 * channel.send(new Uint8Array([1, 2, 3]));
 * channel.close();
 */
export class PowerDatagramChannel {
  /**
   * @param {any} transport - An object with a `send(data)` method and an
   *   optional `readyState` or `isOpen` property. The transport is used
   *   as-is; this class does not normalise its state machine.
   * @param {PowerDatagramChannelOptions} [options]
   */
  constructor(transport, options = /** @type {PowerDatagramChannelOptions} */ ({})) {
    assertKnownOptions(
      options,
      ['onError', 'maxDatagramSizeBytes', 'maxQueue', 'observability'],
      'PowerDatagramChannel'
    );
    const { onError, maxDatagramSizeBytes = 65535, maxQueue = 64 } = options || {};

    if (!transport || typeof transport.send !== 'function') {
      throw new TypeError('PowerDatagramChannel: expected a transport with a `send(data)` method');
    }

    /** @type {any} */
    this._transport = transport;
    /** @type {?((arg0: Error, arg1: object) => void)} */
    this._onError = typeof onError === 'function' ? onError : null;
    /** @type {boolean} */
    this._disposed = false;

    /**
     * Hard ceiling on outbound datagram size, in bytes.
     * @type {number}
     */
    this._maxDatagramSizeBytes = assertLimitRequired(maxDatagramSizeBytes, {
      name: 'maxDatagramSizeBytes',
      className: 'PowerDatagramChannel',
      min: 0,
      fallback: 65535,
    });

    /**
     * Maximum datagrams buffered for sending when the transport is not ready.
     * @type {number}
     */
    this._maxQueue = Math.max(0, Math.floor(Number(maxQueue)));

    /**
     * Datagrams waiting to be sent. A plain array — the class reads `.length`,
     * `.push` and `.shift` only.
     * @type {any[]}
     */
    this._queue = [];

    /** @type {number} */
    this._sentCount = 0;
    /** @type {number} */
    this._droppedCount = 0;
    /** @type {number} */
    this._oversizeCount = 0;
    /** @type {number} */
    this._errorCount = 0;
    /** @type {number} */
    this._bytesOut = 0;

    // FEAT-007: opt-in metrics. Off by default.
    this._metrics = attach(this, 'datagramChannel', options);
  }

  /**
   * Whether the underlying transport looks open.
   *
   * Reads `transport.readyState === 'open'` or `transport.isOpen === true`,
   * falling back to `true` when neither is present — a transport that does not
   * expose a state flag is assumed open, because the alternative is refusing
   * every datagram by default.
   *
   * @returns {boolean}
   */
  get isOpen() {
    const t = this._transport;
    if (!t) return false;
    if (typeof t.readyState === 'string') return t.readyState === 'open';
    if (typeof t.isOpen === 'boolean') return t.isOpen;
    return true;
  }

  /**
   * Send one datagram.
   *
   * **Two refusals, and they are not the same thing:**
   *
   * - **Oversize → `TypeError`.** Permanent. No amount of retrying makes a
   *   datagram smaller, and the refusal is counted in `stats().oversizeDatagrams`
   *   so a caller can see how often it happens.
   * - **Not open or queue full → `false`.** Transient. The caller retries. A
   *   full queue drops the oldest datagram first (`drop-oldest`) and increments
   *   `stats().dropped`, so the loss is observable.
   *
   * @param {string|ArrayBuffer|ArrayBufferView} datagram - The datagram to send.
   * @returns {boolean} `false` when the transport is not ready or the queue is
   *   full. Throws only for an oversize datagram.
   * @throws {TypeError} When `datagram` exceeds `maxDatagramSizeBytes`.
   */
  send(datagram) {
    if (this._disposed) return false;

    const size = frameByteLength(datagram);

    // Hard size check before the transport sees the datagram.
    if (this._maxDatagramSizeBytes > 0 && size > this._maxDatagramSizeBytes) {
      this._oversizeCount += 1;
      const err = new TypeError(
        `PowerDatagramChannel: datagram is ${size} bytes, exceeding the ` +
          `maxDatagramSizeBytes limit of ${this._maxDatagramSizeBytes}`
      );
      this._emitError(err, { datagramSize: size, limit: this._maxDatagramSizeBytes });
      throw err;
    }

    // If the transport is not open, queue or refuse.
    if (!this.isOpen) {
      if (this._maxQueue > 0 && this._queue.length < this._maxQueue) {
        this._queue.push(datagram);
        return true;
      }
      // Queue full or disabled: drop the oldest to make room, then queue the
      // new datagram if room exists, otherwise refuse it.
      if (this._maxQueue > 0 && this._queue.length > 0) {
        this._queue.shift();
        this._droppedCount += 1;
      }
      if (this._maxQueue > 0 && this._queue.length < this._maxQueue) {
        this._queue.push(datagram);
        return true;
      }
      this._droppedCount += 1;
      return false;
    }

    // Transport is open: send directly.
    try {
      this._transport.send(datagram);
    } catch (e) {
      this._emitError(e, { datagramSize: size });
      return false;
    }

    this._sentCount += 1;
    this._bytesOut += size;
    return true;
  }

  /**
   * Flush the internal queue to the transport.
   *
   * Called by the owner when the transport transitions to open, or periodically
   * while it is open. Sends every queued datagram that fits under the size
   * limit; oversize datagrams already in the queue are counted and discarded.
   *
   * @returns {number} The number of datagrams successfully sent.
   */
  flush() {
    if (this._disposed) return 0;

    let sent = 0;
    const stillQueued = [];
    for (const datagram of this._queue) {
      const size = frameByteLength(datagram);
      if (this._maxDatagramSizeBytes > 0 && size > this._maxDatagramSizeBytes) {
        this._oversizeCount += 1;
        this._emitError(
          new TypeError(
            `PowerDatagramChannel: queued datagram is ${size} bytes, ` +
              `exceeding the limit of ${this._maxDatagramSizeBytes}`
          ),
          { datagramSize: size, limit: this._maxDatagramSizeBytes, queued: true }
        );
        continue;
      }
      try {
        this._transport.send(datagram);
      } catch (e) {
        this._errorCount += 1;
        this._emitError(e, { datagramSize: size, queued: true });
        stillQueued.push(datagram);
        continue;
      }
      this._sentCount += 1;
      this._bytesOut += size;
      sent += 1;
    }
    this._queue = stillQueued;
    return sent;
  }

  /**
   * Close the channel.
   *
   * Safe to call more than once. Does not close the underlying transport — that
   * is the caller's responsibility — but stops this class from accepting new
   * datagrams and flushes the internal queue one last time.
   *
   * @returns {void}
   */
  close() {
    if (this._disposed) return;
    this._disposed = true;
    // Final flush attempt: the transport may have become ready since the last
    // queued send.
    this.flush();
  }

  /**
   * Detach listeners and drop the transport reference.
   *
   * `dispose()` is idempotent.
   *
   * @returns {void}
   */
  dispose() {
    detach(this._metrics);
    this._metrics = null;
    if (this._disposed) return;
    this._disposed = true;
    this._queue = [];
    this._transport = null;
    this._onError = null;
  }

  /**
   * Alias for {@link PowerDatagramChannel#dispose}, so `using` works.
   */
  [Symbol.dispose]() {
    this.dispose();
  }

  /**
   * Counters and configuration for this channel.
   *
   * @returns {object}
   */
  stats() {
    return {
      sentCount: this._sentCount,
      droppedCount: this._droppedCount,
      oversizeDatagrams: this._oversizeCount,
      errorCount: this._errorCount,
      bytesOut: this._bytesOut,
      queued: this._queue.length,
      maxQueue: this._maxQueue,
      maxDatagramSizeBytes: this._maxDatagramSizeBytes,
      disposed: this._disposed,
    };
  }

  /**
   * Alias for {@link stats}.
   *
   * See `guides/stats-naming.md` for why both spellings exist and why this
   * method is written out per class.
   */
  getStats() {
    return this.stats();
  }

  /**
   * @private
   * @param {unknown} err
   * @param {object} [ctx]
   */
  _emitError(err, ctx = {}) {
    this._errorCount += 1;
    if (typeof this._onError === 'function') {
      try {
        this._onError(/** @type {Error} */ (err), { channel: this, ...ctx });
      } catch {
        /* a throwing error handler must not become an unhandled rejection */
      }
    }
  }
}
