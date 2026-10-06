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
 * @returns {Promise<{kind:'stream', writable:WritableStream, readable:ReadableStream, close?:(code:number, reason:string)=>void}>}
 *   A socket object compatible with {@link PowerSocketAdapter}.
 * @since 2.0.0
 */
export function createWebTransportAdapter(session: WebTransport): Promise<{
    kind: "stream";
    writable: WritableStream;
    readable: ReadableStream;
    close?: (code: number, reason: string) => void;
}>;
