/**
 * Whether the runtime can structured-clone, i.e. whether the native carrier —
 * {@link encodeNativeEnvelope}, or the deprecated {@link encodeNative} — is usable.
 * @returns {boolean}
 */
export function canUseNativeClone(): boolean;
/**
 * Whether a value can be stored verbatim by the `raw` codec.
 * @param {any} value
 * @returns {boolean}
 */
export function isRawPayload(value: any): boolean;
/**
 * Pick the codec for a value: `raw` for binary, `json` for everything else.
 * @param {any} value
 * @returns {'json'|'raw'}
 */
export function selectCodec(value: any): "json" | "raw";
/**
 * Encode a value into a framed `Uint8Array`.
 *
 * @param {any} value - The value to encode.
 * @param {Object} [options]
 * @param {'json'|'raw'} [options.codec] - Force a codec. Defaults to
 *   {@link selectCodec}.
 * @returns {Uint8Array} A framed message, ready to `postMessage` or send.
 * @throws {TypeError} On an unknown codec, or when `raw` is forced for a
 *   non-binary value.
 */
export function encodeMessage(value: any, options?: {
    codec?: "json" | "raw" | undefined;
}): Uint8Array;
/**
 * Frame bytes that are already encoded JSON, under the `json` codec.
 *
 * This exists for a caller that caches the *encoded* form of a value - as
 * `PowerPool` does - and wants to reuse it instead of re-serialising. The bytes
 * must be the UTF-8 encoding of a JSON document, which is what `o2u8` produces.
 *
 * The codec id is `json`, not `raw`: `decodeMessage` will parse the payload,
 * which is what the sender meant. Framing pre-encoded JSON as `raw` would hand
 * the receiver a `Uint8Array` and lose the value.
 *
 * @param {Uint8Array|string} json - UTF-8 JSON bytes, or a JSON string to
 *   encode first. A string is accepted because that is what a caller caching
 *   the encoded form actually holds; passing a string here avoids the
 *   double-encode that `o2u8(someJsonString)` would cause.
 * @returns {Uint8Array} A framed message with the `json` codec id.
 */
export function frameEncodedJson(json: Uint8Array | string): Uint8Array;
/**
 * Decode a framed message.
 *
 * @param {Uint8Array|ArrayBuffer|DataView} input - The frame.
 * @param {Object} [options]
 * @param {boolean} [options.strict=true] - Reject an unknown protocol version
 *   instead of attempting a best-effort decode. A future version may change the
 *   layout, so silently mis-parsing is worse than a clear error.
 * @param {boolean} [options.rawAsBytes=false] - For a `raw` frame, return a
 *   `Uint8Array` view over the frame instead of copying the payload out.
 * @returns {{version:number, codec:'json'|'raw', value:any, byteLength:number}}
 *   `byteLength` is the total framed length, which lets a stream reader know how
 *   much to consume. Consuming it is {@link createFrameDecoder}'s job; this
 *   function still requires one whole frame.
 */
export function decodeMessage(input: Uint8Array | ArrayBuffer | DataView, options?: {
    strict?: boolean | undefined;
    rawAsBytes?: boolean | undefined;
}): {
    version: number;
    codec: "json" | "raw";
    value: any;
    byteLength: number;
};
/**
 * Create an incremental frame decoder over an arbitrary byte stream.
 *
 * {@link decodeMessage} reads **one whole frame** and throws on anything less,
 * so it cannot be pointed at a socket, a `ReadableStream` or a `node:stream`
 * chunk — and it does throw, with a `RangeError` that says nothing about the
 * fact that the frame was merely *incomplete* rather than corrupt. That is the
 * normal state of a stream roughly once per frame, so the error arrives at a
 * rate that trains the reader to swallow it.
 *
 * A second, quieter failure sits behind it: feed `decodeMessage` a chunk
 * carrying two frames and it returns the first and stops, reporting a
 * `byteLength` smaller than the input. Nothing throws. The remaining bytes are
 * simply never looked at, and the loss is invisible at the call site.
 *
 * ```javascript
 * const decoder = createFrameDecoder({ maxFrameBytes: 1 << 20 });
 * for await (const chunk of stream) {
 *   for (const { value } of decoder.push(chunk)) handle(value);
 * }
 * const tail = decoder.flush();
 * if (tail.length) console.warn('stream ended mid-frame', tail.length, 'bytes short');
 * ```
 *
 * The object is transport-neutral and synchronous. It is not a
 * `ReadableStream` transformer and not a generator, because the one thing it
 * has to get right — never mistaking a half-written payload for a whole one —
 * is a property of *byte counts*, and wrapping it in a stream abstraction moves
 * that arithmetic somewhere nobody will read it.
 *
 * ## How it buffers
 *
 * A read cursor and a write cursor over one growable buffer. The accumulated
 * bytes are **not** re-copied on every `push`: the copy happens when the buffer
 * has to grow, and the live remainder is compacted in place when it would
 * otherwise force a growth it does not need. Re-concatenating per `push` is
 * O(n²) in the chunk count; this is linear in the bytes.
 *
 * That is a statement about asymptotics, deliberately **not** a speed claim.
 * Measured at the shape this was designed against — 500 frames of ~422 bytes
 * delivered in 157 chunks of 1400 — offset bookkeeping and a naive
 * re-concatenate per chunk are indistinguishable: 1.00x and 1.19x on two runs,
 * with a 55-60 % min/max spread against a 28 % noise floor on this machine. The
 * two only separate once a frame is big enough for the copy to matter (1.9x at
 * 32 KB frames), because at 422 bytes the copy is L1-resident and free. See the
 * "Not a speedup" section of the guide.
 *
 * ## The ceiling is required
 *
 * `maxFrameBytes` has no default and is not optional. A frame declares its own
 * payload length, so a peer that sends a 6-byte header and then nothing holds
 * this decoder's buffer open at whatever size it named — with no bound, no
 * counter and no error. A default would be the same defect as RT-009's: a limit
 * that sounds like one and is not. Pass `Infinity` to say so out loud; that
 * call is greppable, which a default is not.
 *
 * The ceiling is checked **when the header arrives**, not when the frame
 * completes, so an oversized frame is refused before its payload is buffered
 * rather than after. It bounds one frame, so a chunk carrying many small frames
 * may still transiently exceed it.
 *
 * @param {Object} options
 * @param {number} options.maxFrameBytes - Largest acceptable **total** framed
 *   length, header included. Required; `Infinity` opts out of the ceiling.
 * @param {boolean} [options.strict=true] - Passed to {@link decodeMessage} per
 *   frame. An unknown protocol version throws from `push`.
 * @param {boolean} [options.rawAsBytes=false] - Passed to
 *   {@link decodeMessage} per frame. Note that with a stream the view is only
 *   valid until the next `push`, which is a stronger caveat than it is for a
 *   complete frame.
 * @returns {{push: (chunk: Uint8Array|ArrayBuffer|DataView) => Array<{version:number, codec:'json'|'raw', value:any, byteLength:number}>, flush: (options?: {strict?: boolean}) => Uint8Array, reset: () => void, dispose: () => void, readonly pendingBytes: number, [Symbol.dispose]: () => void}}
 * @throws {TypeError} If `maxFrameBytes` is absent, not a whole number, or
 *   below {@link HEADER_BYTES}.
 * @throws {RangeError} From `push`, naming `maxFrameBytes`, when a frame
 *   declares a length over the ceiling. From `flush({ strict: true })`, when the
 *   stream ended mid-frame.
 */
export function createFrameDecoder(options: {
    maxFrameBytes: number;
    strict?: boolean | undefined;
    rawAsBytes?: boolean | undefined;
}): {
    push: (chunk: Uint8Array | ArrayBuffer | DataView) => Array<{
        version: number;
        codec: "json" | "raw";
        value: any;
        byteLength: number;
    }>;
    flush: (options?: {
        strict?: boolean;
    }) => Uint8Array;
    reset: () => void;
    dispose: () => void;
    readonly pendingBytes: number;
    [Symbol.dispose]: () => void;
};
/**
 * Encode a value for a `MessagePort` / `Worker` using the platform's structured
 * clone, with no framing and no serialization.
 *
 * @deprecated **RT-023. Use {@link encodeNativeEnvelope} instead**, which does not
 *   clone. This function clones the value *and* hands the clone back for the caller
 *   to post — and `postMessage` then clones it again, because a transfer list only
 *   ever names buffers inside the object being posted and never replaces the clone.
 *   **So the common case pays for two deep copies where one suffices.** Measured on
 *   the real path (the encode, plus the clone `postMessage` performs), median of
 *   nine passes over 4 000 iterations, stable across three orderings: **~3 800 ns
 *   with this, ~260 ns with the envelope — about 14x** on a small object, with the
 *   extra clone ~95% of the cost. That is far outside the 28% median min/max spread
 *   BENCH-001 measures, so the direction and rough magnitude are solid even though
 *   the absolute figure is machine-specific: an earlier subagent measurement of the
 *   same defect read 50 µs on different hardware, and **the robust claim is the
 *   ratio, not either absolute number.**
 *
 *   **Deprecated, not wrong — and one caller still needs it.** Posting binary
 *   without detaching the caller's data requires a private copy *and* a transfer
 *   list naming that copy's buffers, and this is the only call that returns both.
 *   `PowerPool._encodeNativeForWorker` uses it for exactly that case. If your
 *   message has no `ArrayBuffer` in it — the overwhelming majority — there is
 *   nothing to protect and the envelope is strictly better.
 *
 *   This is the first `@deprecated` in the library, so the convention is set here:
 *   the tag names the replacement, and the body says what breaks if you ignore it.
 *   The export stays — removing it is a breaking change to the published surface,
 *   and the pool's own use would break with it.
 *
 * This is the fast path for in-process boundaries — faster than the `json` frame
 * and lossless for `Map`, `Set`, `Date`, `RegExp`, cycles and binary. It is
 * *not* a byte stream, so it cannot be used over a WebSocket; use
 * {@link encodeMessage} there.
 *
 * @param {any} value
 * @returns {{message:any, transfer:ArrayBuffer[]}} The message to pass to
 *   `postMessage` and the transfer list to pass alongside it. The list is empty
 *   when the value contains no transferable buffer.
 */
export function encodeNative(value: any): {
    message: any;
    transfer: ArrayBuffer[];
};
/**
 * The transfer list for a framed `Uint8Array`. Note that transferring detaches
 * the frame's `buffer`, so the frame must not be reused afterwards.
 *
 * Two inputs cannot be answered by handing back `frame.buffer`, and both were
 * **wrong answers rather than slow ones** (RT-022):
 *
 * - A **SAB-backed** frame. A `SharedArrayBuffer` is not transferable, so naming
 *   one here makes `postMessage` throw `DOMException: Found invalid value in
 *   transferList` \u2014 measured \u2014 rather than post. It must also not be detached, so the
 *   only correct answer is to leave it out and let the frame be copied.
 * - A **view into a slab**. `frame.buffer` names the whole buffer, so a 6-byte
 *   view into a 16-byte slab transferred all 16 and left the caller with a
 *   detached slab \u2014 measured, `slab.byteLength === 0` afterwards \u2014 silently
 *   destroying bytes that had nothing to do with this frame. There is no
 *   transfer list that expresses "these six bytes", so this is rejected instead.
 *
 * @param {Uint8Array} frame
 * @returns {ArrayBuffer[]}
 * @throws {RangeError} When `frame` is a view into part of a larger buffer.
 */
export function frameTransferList(frame: Uint8Array): ArrayBuffer[];
/**
 * Whether a value is a native structured-clone envelope.
 *
 * Checked by shape, and that is not sniffing in the sense ADR 0001 rejected:
 * a discriminator is exactly what a sniffing-free protocol is made of. The
 * alternative — inferring the carrier from the value — is what the 1.x path
 * did with `JSON.parse`, and it is what makes a `Date` a string and a `Map` an
 * object literal.
 *
 * @param {any} value
 * @returns {boolean}
 */
export function isNativeEnvelope(value: any): boolean;
/**
 * Whether a value is a worker advertising what it can decode.
 *
 * @param {any} value
 * @returns {boolean}
 */
export function isCapabilityAnnouncement(value: any): boolean;
/**
 * Wrap a value for the native structured-clone carrier.
 *
 * Unlike {@link encodeNative} this does **not** clone: the transport clones
 * whatever it is handed, so cloning here would be a second deep copy for no
 * benefit. That is why it also computes no transfer list — a transfer list has
 * to name buffers inside the object being posted, and the only safe way to
 * post a caller's buffer without detaching it is to post a private copy. A
 * caller that needs the copy pays for it with {@link encodeNative}; the common
 * case, a message with no binary in it, pays nothing.
 *
 * @param {any} value
 * @param {Object} [options]
 * @param {string} [options.correlationId] - Echoed in replies. Top-level, not
 *   nested, because that is where the pool looks when settling a response.
 * @returns {{__pp: 1, kind: 'envelope', value: any, correlationId?: string}}
 */
export function encodeNativeEnvelope(value: any, options?: {
    correlationId?: string | undefined;
}): {
    __pp: 1;
    kind: "envelope";
    value: any;
    correlationId?: string;
};
/**
 * Build the message a worker posts to advertise the carriers it can decode.
 *
 * Post it once, on start-up, before or with the worker's first reply. The pool
 * records it per worker and posts the native carrier to that worker from the
 * next message on; every other worker keeps receiving the framed JSON.
 *
 * @param {Object} [options]
 * @param {string[]} [options.codecs=['json','native']] - Carriers this worker
 *   can decode. `json` is always safe to claim: it is what the pool sends
 *   until the announcement arrives, so a worker that decodes frames must not
 *   claim anything else instead.
 * @returns {{__pp: 1, kind: 'capabilities', codecs: string[], protocol: number}}
 */
export function announceCapabilities(options?: {
    codecs?: string[] | undefined;
}): {
    __pp: 1;
    kind: "capabilities";
    codecs: string[];
    protocol: number;
};
/**
 * Every `ArrayBuffer` reachable from a value, for a transfer list.
 *
 * Depth-limited, and it walks object properties only. Both limits fail in the
 * safe direction: a buffer it cannot reach is copied by the platform rather
 * than transferred, which is slower and never wrong. Widening the walk is a
 * performance change to make deliberately, not a correctness fix.
 *
 * @param {any} value
 * @param {number} [maxDepth=8]
 * @returns {ArrayBuffer[]} Unique buffers, in encounter order.
 */
export function collectTransferables(value: any, maxDepth?: number): ArrayBuffer[];
/**
 * Read any message the pool can send, whatever carrier it arrived on.
 *
 * This is the worker half of protocol negotiation, and it exists because the
 * three-way fallback it replaces was copy-pasted into every worker in the
 * wild — the try-the-frame-and-fall-back-to-bare-JSON dance, re-derived each
 * time and slightly differently each time.
 *
 * Order matters and is not arbitrary:
 *
 * 1. A **native envelope** first. It is an object, so a byte test would not
 *    see it, but checking it first costs one property read.
 * 2. Then a **framed message**, and only when its version byte claims version
 *    1. That is not sniffing either — it is the version check the frame format
 *    exists for. It is also what makes the fallback below safe to attempt on
 *    every message: no JSON document can start with `0x01`, so a legacy body
 *    can never be mistaken for a frame, and a version-2 frame still reports the
 *    version error it actually is.
 * 3. Then a **legacy bare-JSON body**, for a pool still on `messageCodec:
 *    'legacy'`.
 *
 * @param {any} data - `e.data`, or the payload of a bare `'message'` callback.
 * @returns {{codec: 'native'|'json'|'raw'|'legacy', value: any, correlationId: (string|undefined)}}
 * @throws {TypeError} When the input is a byte stream that is neither a valid
 *   frame nor valid JSON.
 */
export function decodeInbound(data: any): {
    codec: "native" | "json" | "raw" | "legacy";
    value: any;
    correlationId: (string | undefined);
};
/** Current protocol version written into every frame. */
export const MESSAGE_PROTOCOL_VERSION: 1;
/**
 * Frame payload codecs.
 *
 * - `json` (`0`) — `JSON.stringify` / `JSON.parse` over UTF-8. Portable across
 *   every runtime and the only choice that interoperates with older peers. Does
 *   not handle `undefined`, `BigInt`, cycles, `Map`/`Set`, or binary.
 * - `raw` (`2`) — the value is already an `ArrayBuffer` or typed array and is
 *   stored verbatim, with no serialization at all.
 */
export type CODECS = number;
/**
 * Frame payload codecs.
 *
 * - `json` (`0`) — `JSON.stringify` / `JSON.parse` over UTF-8. Portable across
 *   every runtime and the only choice that interoperates with older peers. Does
 *   not handle `undefined`, `BigInt`, cycles, `Map`/`Set`, or binary.
 * - `raw` (`2`) — the value is already an `ArrayBuffer` or typed array and is
 *   stored verbatim, with no serialization at all.
 *
 * @readonly
 * @enum {number}
 */
export const CODECS: Readonly<{
    JSON: 0;
    RAW: 2;
}>;
/** Number of bytes in the frame header. */
export const HEADER_BYTES: 6;
/**
 * The `PowerPool` wire modes this module knows how to speak.
 *
 * A pool validates its `messageCodec` against this set so a typo
 * (`'framd'`) degrades to the documented default instead of silently
 * selecting a protocol the caller did not ask for.
 *
 * @readonly
 * @type {Set<'framed'|'legacy'|'negotiated'>}
 */
export const MESSAGE_CODECS: Set<"framed" | "legacy" | "negotiated">;
/** Key marking a protocol message posted *by* a worker to the pool. */
export const NATIVE_ENVELOPE_KEY: "__pp";
/** Version of the negotiation envelope itself, independent of the frame version. */
export const NATIVE_PROTOCOL_VERSION: 1;
/**
 * Namespace object, for `import { PowerMessageCodec } from ...` and for
 * `PowerMessageCodec.encodeMessage(...)` call sites.
 */
export const PowerMessageCodec: Readonly<{
    MESSAGE_PROTOCOL_VERSION: 1;
    CODECS: Readonly<{
        JSON: 0;
        RAW: 2;
    }>;
    MESSAGE_CODECS: Set<"framed" | "legacy" | "negotiated">;
    HEADER_BYTES: 6;
    encodeMessage: typeof encodeMessage;
    decodeMessage: typeof decodeMessage;
    createFrameDecoder: typeof createFrameDecoder;
    frameEncodedJson: typeof frameEncodedJson;
    encodeNative: typeof encodeNative;
    canUseNativeClone: typeof canUseNativeClone;
    selectCodec: typeof selectCodec;
    isRawPayload: typeof isRawPayload;
    frameTransferList: typeof frameTransferList;
    NATIVE_ENVELOPE_KEY: "__pp";
    NATIVE_PROTOCOL_VERSION: 1;
    isNativeEnvelope: typeof isNativeEnvelope;
    isCapabilityAnnouncement: typeof isCapabilityAnnouncement;
    encodeNativeEnvelope: typeof encodeNativeEnvelope;
    announceCapabilities: typeof announceCapabilities;
    collectTransferables: typeof collectTransferables;
    decodeInbound: typeof decodeInbound;
}>;
export default PowerMessageCodec;
