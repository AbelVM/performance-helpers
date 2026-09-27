/**
 * Whether the runtime can structured-clone, i.e. whether
 * {@link encodeNative} is usable.
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
 *   much to consume.
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
 * Encode a value for a `MessagePort` / `Worker` using the platform's structured
 * clone, with no framing and no serialization.
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
 * @param {Uint8Array} frame
 * @returns {ArrayBuffer[]}
 */
export function frameTransferList(frame: Uint8Array): ArrayBuffer[];
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
 * Namespace object, for `import { PowerMessageCodec } from ...` and for
 * `PowerMessageCodec.encodeMessage(...)` call sites.
 */
export const PowerMessageCodec: Readonly<{
    MESSAGE_PROTOCOL_VERSION: 1;
    CODECS: Readonly<{
        JSON: 0;
        RAW: 2;
    }>;
    HEADER_BYTES: 6;
    encodeMessage: typeof encodeMessage;
    decodeMessage: typeof decodeMessage;
    encodeNative: typeof encodeNative;
    canUseNativeClone: typeof canUseNativeClone;
    selectCodec: typeof selectCodec;
    isRawPayload: typeof isRawPayload;
    frameTransferList: typeof frameTransferList;
}>;
export default PowerMessageCodec;
