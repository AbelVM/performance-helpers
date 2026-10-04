/**
 *  Lightweight buffer helpers optimized for frequent encode/decode paths.
 * - Reuse a module-level TextEncoder/TextDecoder to avoid per-call allocations.
 * - Accept ArrayBuffer / TypedArray inputs and prefer zero-copy when possible.
 * - Provide explicit Uint8Array helpers (`o2u8`/`u82o`) for transferable-friendly, zero-copy usage.
 * - Avoid importing the `buffer` polyfill; fall back to Node Buffer only if necessary.
 *
 */
// Lazily-resolved codec cache. Three states, and the comment above used to be
// the only record of them:
//   `undefined` - not probed yet
//   `false`     - probed, and this runtime has no encoder/decoder
//   an object   - the resolved codec
/** @type {(BufferEncoder|false|undefined)} */
let _encoder;
/** @type {(BufferDecoder|false|undefined)} */
let _decoder;

/**
 * @typedef {import('./jsdoc-types.js').BufferEncoder} BufferEncoder
 */

/**
 * @typedef {import('./jsdoc-types.js').BufferDecoder} BufferDecoder
 */

/**
 * Resolve a UTF-8 encoder, caching the answer - including "there is none".
 *
 * @returns {?BufferEncoder} `null` when the runtime has neither
 *   `TextEncoder` nor Node's `Buffer`.
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
  // **Absence is deliberately not cached.** It used to be, as `_encoder = false`,
  // so the "unavailable" verdict was permanent: a host that gained a
  // `TextEncoder` later — a polyfill loaded after first use, or a module instance
  // shared across `vm` contexts or worker threads — would be told
  // `No TextEncoder or Buffer available` for the rest of the process. Observed,
  // not theorised: a test that stubs `TextEncoder` away poisons the cache for
  // every later test in the file, which is a harness bug pointing at a real one.
  // The positive result *is* still cached, since a constructed encoder stays
  // valid, so the common path costs nothing. Re-checking two `typeof`s in the
  // degraded case is not worth a permanent denial.
  return null;
}

/**
 * Whether `value` is an `ArrayBuffer`, **across realms**.
 *
 * `instanceof` compares against *this realm's* `ArrayBuffer.prototype`, so it is
 * `false` for a buffer created in another `vm` context, another realm, or an
 * iframe — even though the value is exactly what the caller means. The same is
 * true of `Symbol.toStringTag`, which is worse than useless here: a plain object
 * carrying `{ [Symbol.toStringTag]: 'ArrayBuffer' }` reports `[object
 * ArrayBuffer]` *and* is accepted by `new Uint8Array()`, so that check turns a
 * spoof into silent corruption rather than a rejection.
 *
 * `Reflect.get` on the spec's own `byteLength` accessor performs the
 * **internal-slot check**, which is what actually identifies an `ArrayBuffer` and
 * is unforgeable: the accessor throws `TypeError` for anything else, cross-realm
 * or spoofed. Measured: it returns the length for a real buffer and throws for a
 * tagged impostor.
 *
 * `instanceof` is kept as the **first** test so the same-realm case — which is
 * every call on a normal encode or decode — still costs one comparison. Only a
 * value that fails it pays for `Reflect.get` and the `try`.
 *
 * Declared as a type predicate for the same reason `isError` is: `instanceof`
 * used to *narrow* at every call site, so returning a plain `boolean` here would
 * have traded a realm bug for two fresh type errors where a bare `ArrayBuffer` is
 * passed on.
 *
 * @param {unknown} value
 * @returns {value is ArrayBuffer}
 */
export function isArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return true;
  try {
    return typeof Reflect.get(ArrayBuffer.prototype, 'byteLength', value) === 'number';
  } catch {
    return false;
  }
}

/**
 * @private
 * @param {ArrayBufferLike} buf
 * @returns {boolean}
 */
/**
 * Whether `buf` is a `SharedArrayBuffer`.
 *
 * `instanceof SharedArrayBuffer` is not writable directly: the global is absent
 * from this library's type set, so TS rejects the left-hand side of an `instanceof`
 * expression outright (PERF-005). Routing every use through here fixes that once
 * instead of casting at each site.
 *
 * @private
 * @param {ArrayBufferLike} buf
 * @returns {boolean}
 */
function isSharedBuffer(buf) {
  // `instanceof` for the same-realm fast path, then the internal-slot check for a
  // buffer from another realm — see `isArrayBuffer` for why `Symbol.toStringTag`
  // is not an option. A cross-realm `SharedArrayBuffer` missed both spellings
  // before, and reached `JSON.stringify` as `{}`.
  if (typeof SharedArrayBuffer === 'undefined') return false;
  if (buf instanceof SharedArrayBuffer) return true;
  try {
    return (
      typeof Reflect.get(SharedArrayBuffer.prototype, 'byteLength', /** @type {any} */ (buf)) ===
      'number'
    );
  } catch {
    return false;
  }
}

/**
 * Resolve a UTF-8 decoder, caching the answer - including "there is none".
 *
 * @returns {?BufferDecoder} `null` when the runtime has neither
 *   `TextDecoder` nor Node's `Buffer`.
 */
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
  // Not cached, for the same reason as `getEncoder`: a permanent "unavailable"
  // verdict outlives whatever caused it.
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
 * @param {string} [preStringified] - A pre-computed JSON string for `obj`, so a
 *   caller that already has one (typically as a cache key) does not pay for a
 *   second `JSON.stringify`. Optional: omit it and `obj` is stringified here.
 * @returns {Uint8Array} UTF-8 encoded bytes.
 * @throws {Error} When no encoder is available.
 * @public
 */
export const o2u8 = (obj, preStringified) => {
  if (obj instanceof Uint8Array) return obj;
  if (ArrayBuffer.isView(obj)) return new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
  // `isArrayBuffer()` rather than `instanceof`: a bare `ArrayBuffer` from another
  // realm is a real ArrayBuffer, and missing it dropped the value into
  // `JSON.stringify`, which sent `{}` (WRK-006).
  if (isArrayBuffer(obj)) return new Uint8Array(obj);
  // A `SharedArrayBuffer` is deliberately **not** an `ArrayBuffer` — that is how
  // the platform keeps the two distinguishable — so it needs its own branch. Left
  // to `JSON.stringify` it became the two bytes `{}`, so a value the caller
  // certainly did not mean travelled the wire and came back as an empty object
  // with nothing to say so (PERF-005).
  if (isSharedBuffer(/** @type {ArrayBufferLike} */ (obj))) {
    return new Uint8Array(/** @type {ArrayBuffer} */ (/** @type {unknown} */ (obj)));
  }
  // Allow callers to pass a pre-computed JSON string (e.g. when the same
  // string is also used as a cache key) to avoid a redundant `JSON.stringify`.
  const str = preStringified != null ? preStringified : JSON.stringify(obj);
  // `JSON.stringify` returns **undefined** — not a string, not an error — for
  // `undefined`, a function, and a Symbol. `TextEncoder.encode` has a WebIDL
  // default that turns that into a **zero-byte** frame, so the value crossed the
  // wire as nothing and surfaced at the far end as
  // `SyntaxError: Unexpected end of JSON input` (PERF-005) — naming neither the
  // value nor the encoder. Caught here instead, where the value is in hand.
  if (typeof str !== 'string') {
    throw new TypeError(
      `PowerBuffer.o2u8: JSON.stringify returned ${str === undefined ? 'undefined' : typeof str} ` +
        `for a value of type ${typeof obj}, which is not encodable. Functions, Symbols and ` +
        '`undefined` have no JSON representation.'
    );
  }
  const enc = getEncoder();
  if (typeof enc?.encode === 'function') return enc.encode(str);
  throw new Error('No TextEncoder or Buffer available to encode object');
};

/**
 * Decode a UTF-8 encoded binary (Uint8Array / ArrayBuffer / Buffer) into a JS value by parsing JSON.
 *
 * `ArrayBufferView` is the dependency-free spelling of "any typed array" - it is
 * a TypeScript built-in, unlike `TypedArray`, which is a Node global alias and
 * therefore leaked `@types/node` into the published declarations. Node `Buffer`
 * needs no mention either: it extends `Uint8Array`, so `ArrayBufferView` already
 * covers it, and naming it broke every consumer who has not installed
 * `@types/node`.
 *
 * @param {ArrayBuffer|ArrayBufferView} buf - Binary input containing JSON UTF-8.
 * @returns {*} Parsed JavaScript value.
 * @throws {TypeError} If the input type is not supported.
 * @example
 * const obj = u82o(u8)
 */
/**
 * Decode a UTF-8 encoded binary (ArrayBuffer/TypedArray/Buffer/Uint8Array)
 * into a JavaScript value by parsing JSON.
 *
 * @param {ArrayBuffer|ArrayBufferView} buf - Binary input.
 * @returns {*} Parsed value.
 * @throws {TypeError} If the input type is unsupported.
 */
export const u82o = (buf) => {
  let u8;
  if (buf instanceof Uint8Array) u8 = buf;
  else if (ArrayBuffer.isView(buf)) u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  else if (isArrayBuffer(buf)) u8 = new Uint8Array(buf);
  // Its own branch for the same reason as `o2u8`: a `SharedArrayBuffer` is not an
  // `ArrayBuffer`, so without this a SAB was rejected as an unsupported input
  // rather than decoded (PERF-005).
  else if (isSharedBuffer(buf)) {
    u8 = new Uint8Array(/** @type {ArrayBuffer} */ (/** @type {unknown} */ (buf)));
  } else if (
    typeof Buffer !== 'undefined' &&
    typeof Buffer.isBuffer === 'function' &&
    Buffer.isBuffer(buf)
  )
    u8 = new Uint8Array(buf);
  else throw new TypeError('Unsupported input to u82o, expected ArrayBuffer/TypedArray/Buffer');

  const dec = getDecoder();
  if (typeof dec?.decode === 'function') return JSON.parse(dec.decode(u8));
  // PERF-004. This used to carry a second fallback:
  //
  //     if (typeof TextDecoder !== 'undefined') return JSON.parse(new TextDecoder().decode(u8));
  //
  // **It was unreachable.** `getDecoder()` returns `null` only when the runtime has
  // neither `TextDecoder` nor Node's `Buffer`, so reaching that line means
  // `TextDecoder` is undefined — and the line's own guard is
  // `typeof TextDecoder !== 'undefined'`. It could not run, and reading it suggests
  // a second decoding path that does not exist.
  //
  // It also contradicted this file's own header, which promises a *module-level*
  // `TextEncoder`/`TextDecoder` reused to avoid per-call allocations: a fresh
  // `new TextDecoder()` per call is the opposite of that promise. `o2u8` never had
  // the mirror-image line, which is what made this look like a leftover rather
  // than a deliberate second path.
  //
  // Verified by reaching the branch that *is* live: with both globals absent,
  // `u82o` throws the error below rather than taking any fallback.
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
  // A SAB-backed view's `.buffer` is a `SharedArrayBuffer`, and slicing one returns
  // another — so both zero-copy paths below would hand back shared mutable state under
  // a signature promising an **owning** `ArrayBuffer`. `Uint8Array.prototype.slice`
  // allocates through the species constructor, so this yields a plain one. Only the SAB
  // path copies; every other input keeps its zero-copy promise (PERF-005).
  if (isSharedBuffer(u8.buffer)) return u8.slice().buffer;
  // Not shared, so `u8.buffer` really is an `ArrayBuffer`; the cast is only here
  // because `Uint8Array#buffer` is typed `ArrayBufferLike` and TS cannot narrow it.
  const buf = /** @type {ArrayBuffer} */ (/** @type {unknown} */ (u8.buffer));
  // prefer zero-copy when the view covers the full underlying buffer
  if (u8.byteOffset === 0 && u8.byteLength === buf.byteLength) return buf;
  return buf.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
};

/**
 * Decode an ArrayBuffer/TypedArray/Buffer containing JSON UTF-8 to a value.
 * This is a small wrapper around `u82o` for the legacy ArrayBuffer API.
 *
 * @param {ArrayBuffer|ArrayBufferView} buf - Buffer-like input containing JSON UTF-8.
 * @returns {*} Parsed value.
 * @example
 * const obj = b2o(buf)
 */
/**
 * Decode an ArrayBuffer/TypedArray/Buffer containing JSON UTF-8 to a value.
 *
 * @param {ArrayBuffer|ArrayBufferView} buf - Buffer-like input.
 * @returns {*} Parsed value.
 */
export const b2o = (buf) => u82o(buf);
