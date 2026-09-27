/**
 * Versioned binary framing for helper-to-helper messages.
 *
 * `PowerPool` and any WebSocket transport both need to move structured values
 * across a boundary, and both currently have to *guess* what they received. The
 * pool sniffs — "if it looks like an ArrayBuffer, `JSON.parse` it" — which
 * silently corrupts a genuinely binary worker message. This module replaces
 * sniffing with an explicit, self-describing envelope.
 *
 * ## Frame layout
 *
 * ```
 * byte  0      protocol version  (currently 1)
 * byte  1      codec id          (see CODECS)
 * bytes 2..5   payload length    (uint32 little-endian)
 * bytes 6..    payload
 * ```
 *
 * A length prefix beats newline-delimited JSON for anything but tiny text
 * frames: no escaping is needed, a payload may contain newlines and arbitrary
 * bytes, and the reader knows the frame length before allocating.
 *
 * ## Why there is no `v8` frame
 *
 * It is tempting to add a "V8" codec for speed. There is not one, and shipping a
 * fake would be worse than not having it: the structured-clone algorithm does
 * not produce bytes. It is a native operation that only exists on a
 * `MessagePort`, `Worker` or `postMessage` boundary, and there is no portable
 * way to serialise a structured clone into a transferable buffer without a
 * serialization library — which would break this package's zero-dependency rule.
 *
 * So the two things are split by what they actually are:
 *
 * - {@link encodeMessage} / {@link decodeMessage} — **framed bytes**, for
 *   transports that carry a byte stream (WebSocket, files, HTTP bodies).
 *   Codecs: {@link CODECS.JSON}, {@link CODECS.RAW}.
 * - {@link encodeNative} — **native structured clone**, for a `MessagePort` or
 *   `Worker`, where the platform does the work and no framing is needed at all.
 *
 * @module powerMessageCodec
 * @public
 */
import { o2u8, u82o } from './powerBuffer.js';

/** Current protocol version written into every frame. */
export const MESSAGE_PROTOCOL_VERSION = 1;

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
export const CODECS = Object.freeze({
  JSON: 0,
  RAW: 2,
});

/** Number of bytes in the frame header. */
export const HEADER_BYTES = 6;

const CODEC_BY_ID = new Map([
  [CODECS.JSON, 'json'],
  [CODECS.RAW, 'raw'],
]);
const ID_BY_CODEC = new Map([
  ['json', CODECS.JSON],
  ['raw', CODECS.RAW],
]);

/**
 * Whether the runtime can structured-clone, i.e. whether
 * {@link encodeNative} is usable.
 * @returns {boolean}
 */
export function canUseNativeClone() {
  return typeof structuredClone === 'function';
}

/**
 * Whether a value can be stored verbatim by the `raw` codec.
 * @param {any} value
 * @returns {boolean}
 */
export function isRawPayload(value) {
  return (
    value instanceof ArrayBuffer ||
    (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value))
  );
}

/**
 * Pick the codec for a value: `raw` for binary, `json` for everything else.
 * @param {any} value
 * @returns {'json'|'raw'}
 */
export function selectCodec(value) {
  return isRawPayload(value) ? 'raw' : 'json';
}

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
export function encodeMessage(value, options = {}) {
  const codecName = options.codec || selectCodec(value);
  const codecId = ID_BY_CODEC.get(codecName);
  if (codecId === undefined) {
    throw new TypeError(
      `PowerMessageCodec: unknown codec "${codecName}". Expected "json" or "raw". ` +
        'For structured-clone speed on a MessagePort/Worker use encodeNative() instead.'
    );
  }

  let payload;
  if (codecId === CODECS.RAW) {
    if (!isRawPayload(value)) {
      throw new TypeError(
        'PowerMessageCodec: the "raw" codec requires an ArrayBuffer or a typed array'
      );
    }
    payload =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    payload = o2u8(value);
  }

  return _frame(codecId, payload);
}

/**
 * Write a frame header over an already-prepared payload.
 *
 * The uint32 length is written by hand rather than through a `DataView`, to
 * avoid allocating one per message on what is meant to be a hot path.
 *
 * @private
 * @param {number} codecId
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
function _frame(codecId, payload) {
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  out[0] = MESSAGE_PROTOCOL_VERSION;
  out[1] = codecId;
  out[2] = payload.length & 0xff;
  out[3] = (payload.length >>> 8) & 0xff;
  out[4] = (payload.length >>> 16) & 0xff;
  out[5] = (payload.length >>> 24) & 0xff;
  out.set(payload, HEADER_BYTES);
  return out;
}

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
 * @param {Uint8Array} jsonBytes - UTF-8 JSON bytes.
 * @returns {Uint8Array} A framed message with the `json` codec id.
 */
export function frameEncodedJson(jsonBytes) {
  if (!(jsonBytes instanceof Uint8Array)) {
    throw new TypeError('PowerMessageCodec: frameEncodedJson() requires a Uint8Array');
  }
  return _frame(CODECS.JSON, jsonBytes);
}

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
export function decodeMessage(input, options = {}) {
  const strict = options.strict !== false;
  const bytes = toBytes(input);

  if (bytes.length < HEADER_BYTES) {
    throw new RangeError(
      `PowerMessageCodec: frame is ${bytes.length} bytes, shorter than the ${HEADER_BYTES}-byte header`
    );
  }

  const version = bytes[0];
  if (strict && version !== MESSAGE_PROTOCOL_VERSION) {
    throw new RangeError(
      `PowerMessageCodec: unsupported protocol version ${version} (expected ${MESSAGE_PROTOCOL_VERSION})`
    );
  }

  const codec = CODEC_BY_ID.get(bytes[1]);
  if (codec === undefined) {
    throw new RangeError(`PowerMessageCodec: unknown codec id ${bytes[1]}`);
  }

  const length = (bytes[2] | (bytes[3] << 8) | (bytes[4] << 16) | (bytes[5] << 24)) >>> 0;
  if (bytes.length < HEADER_BYTES + length) {
    throw new RangeError(
      `PowerMessageCodec: frame declares a ${length}-byte payload but only ` +
        `${bytes.length - HEADER_BYTES} bytes are present (truncated frame)`
    );
  }

  const start = HEADER_BYTES;
  const end = start + length;
  const value =
    codec === 'raw'
      ? options.rawAsBytes === true
        ? bytes.subarray(start, end)
        : bytes.slice(start, end)
      : u82o(bytes.subarray(start, end));
  return { version, codec, value, byteLength: end };
}

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
export function encodeNative(value) {
  if (!canUseNativeClone()) {
    throw new TypeError(
      'PowerMessageCodec: structuredClone is unavailable in this runtime. ' +
        'Use encodeMessage() for a portable JSON frame instead.'
    );
  }
  // Clone first so `transfer` is computed against the copy, not the caller's
  // buffer, and so the returned object shares no memory with the input.
  const message = structuredClone(value);
  const transfer = [];
  const collect = (v, depth) => {
    if (!v || depth > 8) return;
    if (v instanceof ArrayBuffer) {
      if (!transfer.includes(v)) transfer.push(v);
      return;
    }
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(v)) {
      if (!transfer.includes(v.buffer)) transfer.push(v.buffer);
      return;
    }
    if (typeof v === 'object') {
      for (const key of Object.keys(v)) collect(v[key], depth + 1);
    }
  };
  collect(message, 0);
  return { message, transfer };
}

/**
 * The transfer list for a framed `Uint8Array`. Note that transferring detaches
 * the frame's `buffer`, so the frame must not be reused afterwards.
 * @param {Uint8Array} frame
 * @returns {ArrayBuffer[]}
 */
export function frameTransferList(frame) {
  return [frame.buffer];
}

/**
 * Coerce the accepted binary inputs to a `Uint8Array` without copying when
 * possible.
 * @private
 * @param {Uint8Array|ArrayBuffer|DataView} input
 * @returns {Uint8Array}
 */
function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('PowerMessageCodec: expected a Uint8Array, ArrayBuffer or DataView');
}

/**
 * Namespace object, for `import { PowerMessageCodec } from ...` and for
 * `PowerMessageCodec.encodeMessage(...)` call sites.
 */
export const PowerMessageCodec = Object.freeze({
  MESSAGE_PROTOCOL_VERSION,
  CODECS,
  HEADER_BYTES,
  encodeMessage,
  decodeMessage,
  frameEncodedJson,
  encodeNative,
  canUseNativeClone,
  selectCodec,
  isRawPayload,
  frameTransferList,
});

export default PowerMessageCodec;
