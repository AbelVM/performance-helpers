/**
 * Build a `send(subscriber, frame)` adapter for SSE.
 *
 * The adapter owns the per-subscriber writer lifecycle: it writes each frame
 * as one SSE `data:` line, awaits back-pressure, and closes the stream when
 * the hub detaches the subscriber.
 *
 * @param {SseAdapterOptions} [options]
 */
export function createSseAdapter(options?: SseAdapterOptions): {
    send: (sub: object, frame: Uint8Array) => Promise<void>;
    close: (sub: object) => void;
    register: (sub: object) => void;
    lastEventId: (sub: object) => string | null;
    lastSentId: (sub: object) => number;
    dispose: () => void;
    [Symbol.dispose]: () => void;
    [Symbol.asyncDispose]: () => Promise<void>;
};
export type SseSubscriber = {
    id: string;
    writer: WritableStreamDefaultWriter | null;
    abort: AbortController | null;
    closed: boolean;
    /**
     * - Monotonic per-subscriber event id, emitted as the
     * SSE `id:` field. See {@link frameToSseLine}.
     */
    seq: number;
    /**
     * - The `Last-Event-ID` the client sent when
     * it (re)connected, or `null` on a first connect. This is the resume point;
     * replaying from it is the caller's job, because the adapter holds no buffer.
     */
    lastEventId: string | null;
};
export type SseAdapterOptions = {
    /**
     * - Required in the
     * browser. Receives the subscriber record and must return an SSE `Response`
     * whose body is a `WritableStream`. When omitted the adapter falls back to
     * Node's `ServerResponse` shape if `subscriber.transport` exposes
     * `writeHead`/`write`/`end`.
     */
    createResponse?: ((arg0: object) => Response) | undefined;
    /**
     * - Called when a write
     * to the stream throws, instead of leaving an unhandled rejection.
     */
    onError?: ((arg0: Error, arg1: object) => void) | undefined;
};
