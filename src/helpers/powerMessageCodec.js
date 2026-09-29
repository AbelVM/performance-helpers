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
 * - {@link encodeNative} / {@link encodeNativeEnvelope} — **native structured
 *   clone**, for a `MessagePort` or `Worker`, where the platform does the work
 *   and no framing is needed at all. Lossless for `Map`, `Set`, `Date`,
 *   `BigInt`, cycles and binary, which the JSON frame is not — see the
 *   negotiation section below for the measurement.
 *
 * ## Negotiation
 *
 * Which carrier to use is not a property of the value, so this module does not
 * decide it: a worker advertises the carriers it can decode with
 * {@link announceCapabilities}, `PowerPool` records that per worker, and posts
 * the native carrier to that worker alone. A worker that never announces keeps
 * receiving framed JSON, so the feature is opt-in at both ends and cannot break
 * a peer that does not know it exists. {@link decodeInbound} is the worker-side
 * read that handles all three carriers.
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
export const MESSAGE_CODECS = new Set(['framed', 'legacy', 'negotiated']);

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
 * @param {Uint8Array|string} json - UTF-8 JSON bytes, or a JSON string to
 *   encode first. A string is accepted because that is what a caller caching
 *   the encoded form actually holds; passing a string here avoids the
 *   double-encode that `o2u8(someJsonString)` would cause.
 * @returns {Uint8Array} A framed message with the `json` codec id.
 */
export function frameEncodedJson(json) {
  if (typeof json === 'string') return _frame(CODECS.JSON, o2u8(null, json));
  // Deliberately not `json instanceof Uint8Array`. That test is realm-bound: a
  // `Uint8Array` produced by a `TextEncoder` injected from a host realm (a
  // `node:vm` sandbox, an iframe, a test-runner sandbox) is not an instance of
  // *this* realm's Uint8Array, so the check rejected it. `PowerPool`
  // `_prepareForTransfer` then took its `catch` and silently downgraded the
  // message to the 1.x bare-JSON wire format while still reporting
  // `messageCodec: 'framed'` - the worker failed much later, at
  // `decodeMessage`, with a version error that pointed nowhere near the cause.
  if (!isRawPayload(json)) {
    throw new TypeError(
      'PowerMessageCodec: frameEncodedJson() requires a Uint8Array or a JSON string'
    );
  }
  return _frame(CODECS.JSON, toBytes(json));
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

// ─── Protocol negotiation ───────────────────────────────────────────────────
//
// Everything above describes how to put a value on the wire. It does not say
// which carrier to use, because that is not a property of the *value* — it is a
// property of the two processes at either end. A pool that frames everything
// has decided, on the worker's behalf, that JSON is a lossless description of
// every value it will ever be handed.
//
// It is not. Measured against the shipped `framed` path:
//
// | value sent            | what the worker receives |
// | --------------------- | ------------------------ |
// | `new Map([['a', 1]])` | `{}`                     |
// | `new Set([1, 2])`     | `{}`                     |
// | `/ab+c/i`             | `{}`                     |
// | `new Date(0)`         | `"1970-01-01T00:00:00.000Z"` — a **string** |
// | `10n`                 | whole message posted unframed, then `decodeMessage` throws |
// | `Infinity`, `NaN`     | `null`                   |
// | `[1, , 3]`            | `[1, null, 3]`           |
//
// `Date` is the sharpest of these, because the failure is not visible at the
// boundary: the worker gets a string that *looks* like a date, and the first
// `.getTime()` throws somewhere unrelated, long after the postMessage.
//
// The fix is not "make JSON better" — it is to stop assuming. The native
// structured-clone carrier preserves every one of the values above, and the
// platform provides it on exactly the boundary this module already targets.
//
// **The exchange is one-directional on purpose: the worker announces, the pool
// listens.** A pool-asks handshake would have to *send* something an unaware
// worker would interpret as a task, which is worse than not negotiating — ADR
// 0001 rejected negotiation for precisely this reason ("it requires the very
// thing that is unavailable in a failing first run — a working message
// channel"). Reversing the direction removes the objection: a worker that has
// never heard of negotiation simply never announces, and the pool keeps posting
// the framed JSON it posts today. Negotiation cannot fail a peer that does not
// opt in, because the only thing it asks of a peer is silence.

/** Key marking a protocol message posted *by* a worker to the pool. */
export const NATIVE_ENVELOPE_KEY = '__pp';

/** Version of the negotiation envelope itself, independent of the frame version. */
export const NATIVE_PROTOCOL_VERSION = 1;

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
export function isNativeEnvelope(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value[NATIVE_ENVELOPE_KEY] === NATIVE_PROTOCOL_VERSION &&
    value.kind === 'envelope' &&
    'value' in value
  );
}

/**
 * Whether a value is a worker advertising what it can decode.
 *
 * @param {any} value
 * @returns {boolean}
 */
export function isCapabilityAnnouncement(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value[NATIVE_ENVELOPE_KEY] === NATIVE_PROTOCOL_VERSION &&
    value.kind === 'capabilities' &&
    Array.isArray(value.codecs)
  );
}

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
export function encodeNativeEnvelope(value, options = {}) {
  const envelope = { [NATIVE_ENVELOPE_KEY]: NATIVE_PROTOCOL_VERSION, kind: 'envelope', value };
  if (options.correlationId != null) envelope.correlationId = String(options.correlationId);
  return envelope;
}

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
export function announceCapabilities(options = {}) {
  const codecs =
    Array.isArray(options.codecs) && options.codecs.length
      ? options.codecs.filter((c) => c === 'json' || c === 'native')
      : ['json', 'native'];
  return {
    [NATIVE_ENVELOPE_KEY]: NATIVE_PROTOCOL_VERSION,
    kind: 'capabilities',
    codecs: codecs.includes('json') ? codecs : ['json', ...codecs],
    protocol: NATIVE_PROTOCOL_VERSION,
  };
}

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
export function collectTransferables(value, maxDepth = 8) {
  const found = [];
  const seen = new Set();
  const walk = (v, depth) => {
    if (!v || depth > maxDepth) return;
    if (v instanceof ArrayBuffer) {
      if (!seen.has(v)) {
        seen.add(v);
        found.push(v);
      }
      return;
    }
    if (ArrayBuffer.isView(v)) {
      if (!seen.has(v.buffer)) {
        seen.add(v.buffer);
        found.push(v.buffer);
      }
      return;
    }
    if (typeof v === 'object') {
      for (const key of Object.keys(v)) walk(v[key], depth + 1);
    }
  };
  walk(value, 0);
  return found;
}

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
export function decodeInbound(data) {
  if (isNativeEnvelope(data)) {
    return { codec: 'native', value: data.value, correlationId: data.correlationId };
  }
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    const bytes = toBytes(data);
    // Only a body that *claims* to be version 1 is decoded as a frame, so a
    // version-2 frame or a truncated one reports the error it actually is
    // rather than a JSON syntax error from the fallback.
    if (bytes.length >= HEADER_BYTES && bytes[0] === MESSAGE_PROTOCOL_VERSION) {
      const frame = decodeMessage(bytes);
      return { codec: frame.codec, value: frame.value, correlationId: undefined };
    }
    return { codec: 'legacy', value: u82o(bytes), correlationId: undefined };
  }
  return { codec: 'raw', value: data, correlationId: undefined };
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
  MESSAGE_CODECS,
  HEADER_BYTES,
  encodeMessage,
  decodeMessage,
  frameEncodedJson,
  encodeNative,
  canUseNativeClone,
  selectCodec,
  isRawPayload,
  frameTransferList,
  NATIVE_ENVELOPE_KEY,
  NATIVE_PROTOCOL_VERSION,
  isNativeEnvelope,
  isCapabilityAnnouncement,
  encodeNativeEnvelope,
  announceCapabilities,
  collectTransferables,
  decodeInbound,
});

export default PowerMessageCodec;
