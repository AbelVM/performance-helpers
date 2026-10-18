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
 * @property {number} [fragmentSize] - Fragment size for large datagrams. `0`
 *   disables fragmentation. Defaults to `1024` when `fragment` is true.
 * @property {boolean} [fragment] - Enable fragmentation with the default
 *   fragment size.
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
    constructor(transport: any, options?: PowerDatagramChannelOptions);
    /** @type {any} */
    /** @type {?((arg0: Error, arg1: object) => void)} */
    /** @type {boolean} */
    /**
     * Hard ceiling on outbound datagram size, in bytes.
     * @type {number}
     */
    /**
     * Maximum datagrams buffered for sending when the transport is not ready.
     * @type {number}
     */
    /**
     * Fragment size for large datagrams. `0` disables fragmentation.
     * @type {number}
     */
    /** @type {number} */
    /** @type {number} */
    /**
     * Datagrams waiting to be sent. A plain array — the class reads `.length`,
     * `.push` and `.shift` only.
     * @type {any[]}
     */
    /** @type {number} */
    /** @type {number} */
    /** @type {number} */
    /** @type {number} */
    /** @type {number} */
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
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
    get isOpen(): boolean;
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
    send(datagram: string | ArrayBuffer | ArrayBufferView): boolean;
    /**
     * Fragment a large datagram into chunks and send each.
     * @param {any} datagram
     * @param {number} size
     * @returns {boolean}
     * @private
     */
    /**
     * Coerce a datagram to a Uint8Array.
     * @param {any} datagram
     * @returns {Uint8Array}
     * @private
     */
    /**
     * Flush the internal queue to the transport.
     *
     * Called by the owner when the transport transitions to open, or periodically
     * while it is open. Sends every queued datagram that fits under the size
     * limit; oversize datagrams already in the queue are counted and discarded.
     *
     * @returns {number} The number of datagrams successfully sent.
     */
    flush(): number;
    /**
     * Close the channel.
     *
     * Safe to call more than once. Does not close the underlying transport — that
     * is the caller's responsibility — but stops this class from accepting new
     * datagrams and flushes the internal queue one last time.
     *
     * @returns {void}
     */
    close(): void;
    /**
     * Detach listeners and drop the transport reference.
     *
     * `dispose()` is idempotent.
     *
     * @returns {void}
     */
    dispose(): void;
    /**
     * Counters and configuration for this channel.
     *
     * @returns {object}
     */
    stats(): object;
    /**
     * Alias for {@link stats}.
     *
     * See `guides/stats-naming.md` for why both spellings exist and why this
     * method is written out per class.
     */
    getStats(): object;
    /**
     * @private
     * @param {unknown} err
     * @param {object} [ctx]
     */
    /**
     * Alias for {@link PowerDatagramChannel#dispose}, so `using` works.
     */
    [Symbol.dispose](): void;
    /**
     * Asynchronous disposal hook (thin wrapper). Forwards to sync disposal.
     * @returns {Promise<void>}
     */
    [Symbol.asyncDispose](): Promise<void>;
}
export type PowerDatagramChannelOptions = {
    /**
     * - Called when the
     * underlying transport throws or when an oversize datagram is refused.
     */
    onError?: ((arg0: Error, arg1: object) => void) | undefined;
    /**
     * - Hard ceiling on outbound
     * datagram size. A datagram larger than this is refused with a `TypeError`
     * before it reaches the transport. `0` disables the check.
     */
    maxDatagramSizeBytes?: number | undefined;
    /**
     * - Maximum datagrams buffered for sending
     * when the transport is not ready. `0` disables queueing: a datagram arriving
     * while the transport is closed is refused immediately.
     */
    maxQueue?: number | undefined;
    /**
     * -
     * Opt in to metrics. See `guides/metrics.md`.
     */
    observability?: boolean | import("./metrics.js").MetricsCollector | undefined;
    /**
     * - Fragment size for large datagrams. `0`
     * disables fragmentation. Defaults to `1024` when `fragment` is true.
     */
    fragmentSize?: number | undefined;
    /**
     * - Enable fragmentation with the default
     * fragment size.
     */
    fragment?: boolean | undefined;
};
