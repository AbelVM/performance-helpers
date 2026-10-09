/**
 * Wrap a `WebTransport` session in a stream socket that decodes inbound
 * frames.
 *
 * **No connection is opened here.** The caller is expected to have
 * constructed and configured the `WebTransport` already (including
 * `createBidirectionalStreams: true` in the options). The only thing this
 * function does is call `session.createBidirectionalStream()` and wrap the
 * result.
 *
 * @param {WebTransport} session - A live `WebTransport` with bidirectional
 *   streams enabled.
 *   A socket object compatible with {@link PowerSocketAdapter}.
 * @since 2.0.0
 */
export function createWebTransportAdapter(session: WebTransport): Promise<{
    kind: string;
    writable: WritableStream<any>;
    readable: ReadableStream<any>;
    /**
     * Alias of `close()`, so the socket object takes part in `using` /
     * `await using` teardown like every other long-lived helper here.
     *
     * This adapter owns no timer and no listener registry of its own - the
     * pump loop is driven by the stream itself - so `dispose()` is the same
     * operation as `close()`, not a state reset.
     *
     * @param {number} [code]
     * @param {string} [reason]
     * @returns {void}
     */
    dispose(code?: number, reason?: string): void;
    [Symbol.dispose](code?: number, reason?: string): void;
    [Symbol.asyncDispose](code?: number, reason?: string): Promise<void>;
    close(code?: number, reason?: string): void;
}>;
