/**
 *  Lightweight buffer helpers optimized for frequent encode/decode paths.
 * - Reuse a module-level TextEncoder/TextDecoder to avoid per-call allocations.
 * - Accept ArrayBuffer / TypedArray inputs and prefer zero-copy when possible.
 * - Provide explicit Uint8Array helpers (`o2u8`/`u82o`) for transferable-friendly, zero-copy usage.
 * - Avoid importing the `buffer` polyfill; fall back to Node Buffer only if necessary.
 *
 */
// `undefined` = not-yet-checked, object = available encoder/decoder, `false` = unavailable
let _encoder;
let _decoder;

/**
 * @typedef {Object} BufferEncoder
 * @property {(s:string)=>Uint8Array} encode
 */

/**
 * @typedef {Object} BufferDecoder
 * @property {(u8:Uint8Array)=>string} decode
 */

function getEncoder() {
  if (_encoder !== undefined) return _encoder === false ? null : _encoder;
  if (typeof TextEncoder !== 'undefined') {
    _encoder = new TextEncoder();
    return _encoder;
  }
  // fallback: provide a minimal encoder using Node Buffer if available
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    _encoder = { encode: (s) => new Uint8Array(Buffer.from(s)) };
    return _encoder;
  }
  // mark as unavailable so subsequent calls are fast
  _encoder = false;
  return null;
}

function getDecoder() {
  if (_decoder !== undefined) return _decoder === false ? null : _decoder;
  if (typeof TextDecoder !== 'undefined') {
    _decoder = new TextDecoder();
    return _decoder;
  }
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    _decoder = { decode: (u8) => Buffer.from(u8).toString('utf8') };
    return _decoder;
  }
  // mark as unavailable so subsequent calls are fast
  _decoder = false;
  return null;
}

/**
 * Convert a value or buffer-like input to a UTF-8 encoded Uint8Array.
 *
 * - If `obj` is already a `Uint8Array` it is returned as-is.
 * - If `obj` is an ArrayBuffer or TypedArray a zero-copy view is returned.
 * - Otherwise `JSON.stringify(obj)` is encoded as UTF-8.
 *
 * @param {*} obj - Plain object or buffer-like (ArrayBuffer, TypedArray, Buffer).
 * @returns {Uint8Array} UTF-8 encoded view suitable for postMessage transfer.
 * @throws {Error} When no encoder (TextEncoder/Buffer) is available.
 * @example
 * const u8 = o2u8({ hello: 'world' })
 * // use u8.buffer as transferable
 */
/**
 * Encode a plain object or buffer-like value to a UTF-8 `Uint8Array`.
 *
 * - Returns the input if it's already a `Uint8Array`.
 * - Returns a zero-copy view for ArrayBuffer/TypedArray inputs.
 * - Otherwise `JSON.stringify` is encoded as UTF-8.
 *
 * @param {*} obj - Value to encode.
 * @returns {Uint8Array} UTF-8 encoded bytes.
 * @throws {Error} When no encoder is available.
 * @public
 */
export const o2u8 = (obj) => {
  if (obj instanceof Uint8Array) return obj;
  if (ArrayBuffer.isView(obj)) return new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
  if (obj instanceof ArrayBuffer) return new Uint8Array(obj);
  const str = JSON.stringify(obj);
  const enc = getEncoder();
  if (typeof enc?.encode === 'function') return enc.encode(str);
  throw new Error('No TextEncoder or Buffer available to encode object');
};

/**
 * Decode a UTF-8 encoded binary (Uint8Array / ArrayBuffer / Buffer) into a JS value by parsing JSON.
 *
 * @param {ArrayBuffer|TypedArray|Buffer|Uint8Array} buf - Binary input containing JSON UTF-8.
 * @returns {*} Parsed JavaScript value.
 * @throws {TypeError} If the input type is not supported.
 * @example
 * const obj = u82o(u8)
 */
/**
 * Decode a UTF-8 encoded binary (ArrayBuffer/TypedArray/Buffer/Uint8Array)
 * into a JavaScript value by parsing JSON.
 *
 * @param {ArrayBuffer|TypedArray|Buffer|Uint8Array} buf - Binary input.
 * @returns {*} Parsed value.
 * @throws {TypeError} If the input type is unsupported.
 */
export const u82o = (buf) => {
  let u8;
  if (buf instanceof Uint8Array) u8 = buf;
  else if (ArrayBuffer.isView(buf)) u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  else if (buf instanceof ArrayBuffer) u8 = new Uint8Array(buf);
  else if (
    typeof Buffer !== 'undefined' &&
    typeof Buffer.isBuffer === 'function' &&
    Buffer.isBuffer(buf)
  )
    u8 = new Uint8Array(buf);
  else throw new TypeError('Unsupported input to u82o, expected ArrayBuffer/TypedArray/Buffer');

  const dec = getDecoder();
  if (typeof dec?.decode === 'function') return JSON.parse(dec.decode(u8));
  if (typeof TextDecoder !== 'undefined') return JSON.parse(new TextDecoder().decode(u8));
  throw new Error('No TextDecoder or Buffer available to decode object');
};

/**
 * Encode a value to an ArrayBuffer containing JSON UTF-8.
 * Returns an owning ArrayBuffer (may be a slice of the underlying buffer).
 *
 * @param {*} obj - Value to encode.
 * @returns {ArrayBuffer}
 * @example
 * const buf = o2b({ a: 1 })
 */
/**
 * Encode a value to an owning `ArrayBuffer` containing JSON UTF-8.
 *
 * @param {*} obj - Value to encode.
 * @returns {ArrayBuffer}
 */
export const o2b = (obj) => {
  const u8 = o2u8(obj);
  // prefer zero-copy when the view covers the full underlying buffer
  if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer;
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
};

/**
 * Decode an ArrayBuffer/TypedArray/Buffer containing JSON UTF-8 to a value.
 * This is a small wrapper around `u82o` for the legacy ArrayBuffer API.
 *
 * @param {ArrayBuffer|TypedArray|Buffer} buf - Buffer-like input containing JSON UTF-8.
 * @returns {*} Parsed value.
 * @example
 * const obj = b2o(buf)
 */
/**
 * Decode an ArrayBuffer/TypedArray/Buffer containing JSON UTF-8 to a value.
 *
 * @param {ArrayBuffer|TypedArray|Buffer} buf - Buffer-like input.
 * @returns {*} Parsed value.
 */
export const b2o = (buf) => u82o(buf);
