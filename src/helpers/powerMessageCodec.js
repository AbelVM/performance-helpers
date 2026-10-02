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
import { assertLimitRequired } from '../utils/options.js';

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
 * Read a frame's declared payload length out of its header.
 *
 * Extracted rather than inlined in {@link decodeMessage} because
 * {@link createFrameDecoder} has to read the length at a different moment —
 * as soon as the 6 header bytes arrive, before the payload does, so it can
 * refuse a frame the peer has only half-sent. Two copies of this expression is
 * precisely the shape that survives a v2 layout change in one place and not
 * the other, and this project has already paid for a drifted copy of a return
 * type in nine JSDoc blocks.
 *
 * @private
 * @param {Uint8Array} bytes
 * @param {number} [offset=0] Index of the header's first byte.
 * @returns {number} The declared payload length, unsigned.
 */
function _readLength(bytes, offset = 0) {
  return (
    (bytes[offset + 2] |
      (bytes[offset + 3] << 8) |
      (bytes[offset + 4] << 16) |
      (bytes[offset + 5] << 24)) >>>
    0
  );
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
 *   much to consume. Consuming it is {@link createFrameDecoder}'s job; this
 *   function still requires one whole frame.
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

  const length = _readLength(bytes);
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
// No `= {}` default, and the type error that cost is the point: the parameter is
// genuinely required, so the published signature says so, and a caller in
// TypeScript finds out at the call site rather than at the first oversized
// frame. The optional chain below is what keeps the *runtime* message useful
// for the JavaScript caller who passes nothing at all.
export function createFrameDecoder(options) {
  if (options?.maxFrameBytes === undefined) {
    throw new TypeError(
      'PowerMessageCodec: createFrameDecoder() requires `maxFrameBytes`. A frame declares ' +
        'its own payload length, so a peer that sends a header and then stops would pin this ' +
        'buffer at whatever size it named. Pass `Infinity` to accept that risk explicitly.'
    );
  }
  const maxFrameBytes = assertLimitRequired(options.maxFrameBytes, {
    name: 'maxFrameBytes',
    className: 'PowerMessageCodec.createFrameDecoder',
    min: HEADER_BYTES,
    integer: true,
    allowInfinity: true,
  });
  const strict = options.strict !== false;
  const rawAsBytes = options.rawAsBytes === true;

  // 1 KB holds a typical small JSON frame whole, so the common
  // message-per-chunk case never grows the buffer at all.
  const INITIAL_BYTES = 1024;
  let buf = new Uint8Array(INITIAL_BYTES);
  let start = 0;
  let end = 0;

  /**
   * Make room for `incoming` more bytes, compacting before growing.
   * @param {number} incoming
   * @returns {void}
   */
  function _reserve(incoming) {
    if (end + incoming <= buf.length) return;
    const live = end - start;
    // Compaction alone is enough when the live remainder plus the chunk fits in
    // the space already allocated. Worth trying first: a stream that delivers
    // one frame per chunk would otherwise reallocate on a predictable cadence.
    if (live + incoming <= buf.length) {
      buf.copyWithin(0, start, end);
    } else {
      // `|| INITIAL_BYTES` because `dispose()` leaves a zero-length buffer, and
      // doubling zero is zero — the loop below would never terminate.
      let capacity = buf.length || INITIAL_BYTES;
      while (capacity < live + incoming) capacity *= 2;
      const grown = new Uint8Array(capacity);
      // Copying from `start` compacts as a side effect of growing.
      grown.set(buf.subarray(start, end));
      buf = grown;
    }
    start = 0;
    end = live;
  }

  return {
    /**
     * Feed the next chunk of the stream, and take every complete frame out of it.
     *
     * @param {Uint8Array|ArrayBuffer|DataView} chunk - Whatever the transport
     *   handed over. It is copied in, so the caller may reuse or transfer its
     *   buffer immediately.
     * @returns {Array<{version:number, codec:'json'|'raw', value:any, byteLength:number}>}
     *   The frames completed by this chunk — **every** one of them, not the
     *   first. Empty when the chunk held no complete frame, which includes the
     *   ordinary case of a chunk too short to hold a header yet.
     */
    push(chunk) {
      const bytes = toBytes(chunk);
      _reserve(bytes.length);
      buf.set(bytes, end);
      end += bytes.length;

      const frames = [];
      while (end - start >= HEADER_BYTES) {
        const declared = _readLength(buf, start);
        // Checked before the completeness test below, and that ordering is the
        // whole reason the ceiling exists: an oversized frame is refused on its
        // header, so the declared payload is never buffered.
        if (HEADER_BYTES + declared > maxFrameBytes) {
          throw new RangeError(
            `PowerMessageCodec: frame declares ${HEADER_BYTES + declared} bytes, over the ` +
              `maxFrameBytes limit of ${maxFrameBytes}`
          );
        }
        if (end - start < HEADER_BYTES + declared) break;
        // Bounded to the write cursor rather than the buffer's capacity, which
        // is what keeps the raw view and the JSON parse looking only at bytes
        // that were actually received. It is not the guard, though: the check
        // above is. Slicing to capacity here instead leaves every test in
        // `powerMessageCodec.frameDecoder.test.js` green, because
        // `decodeMessage` is never reached with an incomplete frame. Kept
        // because the two have to agree and only one of them is checked.
        const frame = decodeMessage(buf.subarray(start, end), { strict, rawAsBytes });
        frames.push(frame);
        start += frame.byteLength;
      }

      // Fully drained. Rewind rather than allocate, so the steady state of a
      // stream that keeps up costs no garbage.
      if (start === end) {
        start = 0;
        end = 0;
      }
      return frames;
    },

    /**
     * Report what is still buffered, for end-of-stream.
     *
     * @param {Object} [flushOptions]
     * @param {boolean} [flushOptions.strict=false] - Throw a `RangeError`
     *   naming the shortfall instead of returning the bytes.
     * @returns {Uint8Array} A **copy** of the unconsumed remainder, safe to
     *   keep after the decoder is reused or disposed. Zero-length means the
     *   stream ended on a frame boundary and nothing was lost.
     */
    flush(flushOptions = {}) {
      const buffered = end - start;
      if (buffered > 0 && flushOptions.strict === true) {
        const declared = buffered < HEADER_BYTES ? null : _readLength(buf, start);
        const needed = declared === null ? HEADER_BYTES : HEADER_BYTES + declared;
        throw new RangeError(
          `PowerMessageCodec: stream ended mid-frame — ${buffered} of ${needed} bytes buffered` +
            (declared === null ? ', not even a whole header' : '')
        );
      }
      return buf.slice(start, end);
    },

    /** Bytes currently held for an incomplete frame. */
    get pendingBytes() {
      return end - start;
    },

    /**
     * Drop any incomplete frame and start over, keeping the buffer for reuse.
     *
     * For a stream that has desynchronised and cannot be resynchronised: once a
     * frame is mis-parsed the length prefix is no longer trustworthy, so the
     * bytes after it cannot be framed either.
     */
    reset() {
      start = 0;
      end = 0;
    },

    /**
     * Release the buffer.
     *
     * This is a **state reset**, not a cancellation: the decoder owns no timer,
     * no listener and no handle of any kind, only bytes. It is safe to keep
     * pushing afterwards — the next `push` allocates a fresh buffer — so a
     * `using` block that disposes early does not leave a dead object behind.
     */
    dispose() {
      this.reset();
      buf = new Uint8Array(0);
    },

    [Symbol.dispose]() {
      this.dispose();
    },
  };
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
  /** @type {ArrayBuffer[]} */
  const transfer = [];
  // `any` on both parameters deliberately: this walks caller-supplied values of a
  // type the library does not know, and narrowing `v` to `object` here would
  // reject the primitives the `typeof v === 'object'` guard is there to skip.
  const collect = (/** @type {any} */ v, /** @type {number} */ depth) => {
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
  /** @type {ArrayBuffer[]} */
  const found = [];
  const seen = new Set();
  const walk = (/** @type {any} */ v, /** @type {number} */ depth) => {
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
  createFrameDecoder,
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
