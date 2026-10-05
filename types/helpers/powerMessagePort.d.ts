/**
 * @typedef {object} PowerMessagePortOptions
 * @property {function(any, (string|undefined)):void} [onMessage] - Called with
 *   the decoded `value` and optional `correlationId` for each inbound message.
 * @property {function():void} [onClose] - Called when the port closes.
 * @property {function(Error):void} [onError] - Called when an inbound message
 *   cannot be decoded.
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] -
 *   Opt in to metrics. See `guides/metrics.md`.
 */
export class PowerMessagePort {
    /**
     * @param {MessagePort} port - An open or opening `MessagePort`. The adapter
     *   attaches listeners immediately; a port that is not yet `open` queues
     *   messages until it is, which is the platform's normal behaviour.
     * @param {PowerMessagePortOptions} [options]
     */
    constructor(port: MessagePort, options?: PowerMessagePortOptions);
    /** @type {MessagePort} */
    /** @type {?((arg0: any, arg1: string | undefined) => void)} */
    /** @type {?(() => void)} */
    /** @type {?((arg0: Error) => void)} */
    /** @type {boolean} */
    /** @type {number} */
    /** @type {number} */
    /** @type {number} */
    /** @type {'open'|'closed'} */
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
    /**
     * The hub's `send(sub, frame)` adapter.
     *
     * Posts the hub's encoded `Uint8Array` frame to the port. The frame is the
     * hub's own buffer, handed over by reference — the platform serialises
     * synchronously, so a transport that wrote into it would corrupt every other
     * subscriber on the same topic. Copy it if you need to retain it.
     *
     * @param {object} _sub - The subscriber record (unused; present so the hub's
     *   `send(sub, frame)` signature is satisfied).
     * @param {Uint8Array} frame - The hub's encoded frame.
     * @returns {boolean} `false` when the port is already disposed. Throws only
     *   for a platform error.
     */
    send(_sub: object, frame: Uint8Array): boolean;
    /**
     * The hub's `close(sub)` adapter.
     *
     * Safe to call more than once, and safe on a port that closed first.
     *
     * @returns {void}
     */
    close(): void;
    /**
     * Detach every listener and drop the port reference.
     *
     * Required rather than tidy: a `MessagePort` outliving its adapter keeps the
     * handler closure alive, and a peer table that never disposes leaks one
     * adapter per port for the life of the process.
     *
     * `dispose()` is idempotent.
     *
     * @returns {void}
     */
    dispose(): void;
    /**
     * A minimal snapshot for the metrics collector.
     *
     * @returns {object}
     */
    stats(): object;
    /**
     * Alias for {@link PowerMessagePort#stats}, so callers that learned
     * `getStats()` from `PowerPool` are not handed a `TypeError`.
     */
    getStats(): object;
    /**
     * @private
     */
    /**
     * @private
     */
    /**
     * @private
     * @param {unknown} err
     */
    /**
     * Alias for {@link PowerMessagePort#dispose}, so `using` works.
     */
    [Symbol.dispose](): void;
}
export type PowerMessagePortOptions = {
    /**
     * - Called with
     * the decoded `value` and optional `correlationId` for each inbound message.
     */
    onMessage?: ((arg0: any, arg1: (string | undefined)) => void) | undefined;
    /**
     * - Called when the port closes.
     */
    onClose?: (() => void) | undefined;
    /**
     * - Called when an inbound message
     * cannot be decoded.
     */
    onError?: ((arg0: Error) => void) | undefined;
    /**
     * -
     * Opt in to metrics. See `guides/metrics.md`.
     */
    observability?: boolean | import("./metrics.js").MetricsCollector | undefined;
};
