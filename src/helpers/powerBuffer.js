/**
 *  Lightweight buffer helpers optimized for frequent encode/decode paths.
 * - Reuse a module-level TextEncoder/TextDecoder to avoid per-call allocations.
 * - Accept ArrayBuffer / TypedArray inputs and prefer zero-copy when possible.
 * - Provide explicit Uint8Array helpers (`o2u8`/`u82o`) for transferable-friendly, zero-copy usage.
 * - Avoid importing the `buffer` polyfill; fall back to Node Buffer only if necessary.
 *
 */
import { assertKnownOptions, assertLimitRequired } from '../utils/options.js';
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
 * **Two guards sit between the fast path and the `try`, and both are
 * load-bearing.** Measured on the real `collectTransferables`, which calls this
 * on *every value in a payload*:
 *
 * - Without the `typeof` guard, `Reflect.get` **throws** for every primitive —
 *   the `byteLength` accessor performs an internal-slot check and a primitive has
 *   none. A throw is an exception unwind, not a cheap `return false`: **2 116 %
 *   slower** (127 ms to 2 812 ms per 200 k calls) than the bare `instanceof` it
 *   replaced. That regression was introduced by the very change that added the
 *   cross-realm correctness, and was caught only by measuring.
 * A primitive cannot be an `ArrayBuffer`, so the `typeof` guard is not a shortcut
 * that skips work; it is the same answer reached without an exception. The
 * cross-realm path is untouched: a foreign buffer is still an `object`, so it
 * still reaches `Reflect.get` and is still identified.
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
  // Only an object can carry the internal slot. A primitive cannot, and asking
  // the accessor about one throws — which is the expensive way to learn
  // something already known from `typeof`.
  if (value === null || typeof value !== 'object') return false;
  // **The tag is a pre-filter, not the test.** `Object.prototype.toString` reads
  // the internal builtin slot, so it is realm-independent — but it is also
  // spoofable via `Symbol.toStringTag`, which is why the accessor still runs
  // below and still has the final word. What the tag buys is the *rejection*
  // path: measured on Node 24.18, asking the accessor about a non-buffer costs
  // 44.9 ms per 16k calls because every one throws a `TypeError`, while the tag
  // rejects the same values in 0.88 ms — 51×. A caller walking arbitrary user
  // values (`trySignature` in `cache/core.js` does exactly that) pays that on
  // every value, so the cheap reject has to come first.
  if (Object.prototype.toString.call(value) !== '[object ArrayBuffer]') return false;
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
 * Exported for `powerMessageCodec`, which had two bare `instanceof` sites of its
 * own (AUD-011) — one of them walking **arbitrary user values**, where a
 * cross-realm `SharedArrayBuffer` was silently *copied* instead of transferred.
 * The same-realm fast path is first, so the common case still costs one
 * comparison; only a value that fails it pays for `Reflect.get` and the `try`.
 *
 * @param {unknown} buf
 * @returns {boolean}
 */
export function isSharedArrayBuffer(buf) {
  // `instanceof` for the same-realm fast path, then the internal-slot check for a
  // buffer from another realm — see `isArrayBuffer` for why `Symbol.toStringTag`
  // is not an option. A cross-realm `SharedArrayBuffer` missed both spellings
  // before, and reached `JSON.stringify` as `{}`.
  if (typeof SharedArrayBuffer === 'undefined') return false;
  if (buf instanceof SharedArrayBuffer) return true;
  if (buf === null || typeof buf !== 'object') return false;
  // Tag pre-filter, then the accessor has the final word — see `isArrayBuffer`
  // for why the order matters and what it costs to get it wrong.
  if (Object.prototype.toString.call(buf) !== '[object SharedArrayBuffer]') return false;
  try {
    return (
      typeof Reflect.get(SharedArrayBuffer.prototype, 'byteLength', /** @type {object} */ (buf)) ===
      'number'
    );
  } catch {
    return false;
  }
}

/**
 * Whether `value` is a `RegExp`, from any realm.
 *
 * Same shape and same reason as `isArrayBuffer`: `instanceof RegExp` compares
 * against *this* realm's prototype, so a regexp from a `node:vm` sandbox, an
 * iframe or a worker fails it. The internal-slot check is
 * `Reflect.get(RegExp.prototype, 'source', value)` — the spec's own accessor,
 * which performs the slot check, returns the source for a real regexp
 * cross-realm included, and **throws `TypeError`** for an impostor.
 *
 * `flags` is deliberately not the accessor used: it returns `''` rather than
 * throwing for a non-regexp, so it cannot detect anything. `source` throws.
 *
 * `Symbol.toStringTag` is not an option for the usual reason recorded in
 * `isArrayBuffer`: a `{ [Symbol.toStringTag]: 'RegExp' }` stand-in reports
 * `[object RegExp]` and would be accepted. The tag is a pre-filter here and the
 * accessor still has the final word.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRegExp(value) {
  if (value instanceof RegExp) return true;
  if (value === null || typeof value !== 'object') return false;
  if (Object.prototype.toString.call(value) !== '[object RegExp]') return false;
  try {
    return typeof Reflect.get(RegExp.prototype, 'source', value) === 'string';
  } catch {
    return false;
  }
}

/**
 * Whether `value` is a `Date`, from any realm.
 *
 * **The internal-slot check here is a call, not a property read, and getting
 * that wrong is silent.** `Date.prototype` has no accessor that performs the
 * slot check — `getTime` is a *method*, so `Reflect.get(Date.prototype,
 * 'getTime', value)` returns the function for an `ArrayBuffer`, a plain object
 * and a string alike, without throwing. A first draft of this function was
 * written that way and returned `true` for every object it was handed; the
 * tests that caught it were the performance ones, because the caller
 * (`trySignature` in `cache/core.js`) then called `getTime()` on a buffer, threw,
 * and lost the signature for every value.
 *
 * The slot check happens when the method is *invoked*, so that is how it is
 * spelled: `Date.prototype.getTime.call(value)` throws `TypeError` for a
 * non-`Date` and returns for a real one, cross-realm included.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDate(value) {
  if (value instanceof Date) return true;
  if (value === null || typeof value !== 'object') return false;
  if (Object.prototype.toString.call(value) !== '[object Date]') return false;
  try {
    Date.prototype.getTime.call(/** @type {object} */ (value));
    return true;
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
  if (isSharedArrayBuffer(/** @type {ArrayBufferLike} */ (obj))) {
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
  else if (isSharedArrayBuffer(buf)) {
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
  if (isSharedArrayBuffer(u8.buffer)) return u8.slice().buffer;
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

/**
 * A pool of reusable `Uint8Array` buffers, keyed by size bucket.
 *
 * ## Why
 *
 * Hot encode/decode paths (`o2u8`, message codecs, frame builders) allocate a
 * fresh `Uint8Array` per call. For a steady-state workload the sizes are
 * predictable, so the allocations are pure churn: the GC collects them a moment
 * later and the allocator hands out the same memory again. A pool keeps the
 * buffers alive and hands them back out, removing the allocation from the hot
 * path entirely.
 *
 * ## Contract
 *
 * - `acquire(size)` returns a `Uint8Array` whose `byteLength` is at least
 *   `size`. It may be a pooled buffer (reused) or a freshly allocated one.
 *   The caller **owns** the returned buffer until it calls `release()`.
 * - `release(buf)` returns a buffer to the pool. Buffers whose size does not
 *   match a configured bucket, or that arrive when the pool is full, are
 *   dropped (the caller's reference is the only one left, so it is collected).
 * - A buffer handed out by `acquire()` must not be used after `release()`: the
 *   pool may hand the same memory to another caller. This is the documented
 *   footgun of every buffer pool; the saving has to be worth it.
 *
 * @class PowerBufferPool
 * @public
 */
export class PowerBufferPool {
  /**
   * @param {Object} [options]
   * @param {number[]} [options.buckets=[256,1024,4096,16384,65536]] - Size
   *   buckets. A request is served from the smallest bucket that fits; a
   *   request larger than every bucket is allocated fresh and never pooled.
   * @param {number} [options.maxPerBucket=16] - Maximum buffers retained per
   *   bucket.
   * @param {number} [options.maxTotal=256] - Maximum buffers retained across all
   *   buckets.
   */
  constructor(options = {}) {
    assertKnownOptions(options, ['buckets', 'maxPerBucket', 'maxTotal'], 'PowerBufferPool');
    const rawBuckets = Array.isArray(options?.buckets)
      ? options.buckets
      : [256, 1024, 4096, 16384, 65536];
    const buckets = [...new Set(rawBuckets.map((n) => Math.floor(Number(n))))]
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    this._buckets = buckets.length ? buckets : [256];
    this._maxPerBucket = Math.max(
      1,
      Math.floor(
        assertLimitRequired(options?.maxPerBucket, {
          name: 'maxPerBucket',
          className: 'PowerBufferPool',
          min: 1,
          fallback: 16,
        })
      )
    );
    this._maxTotal = Math.max(
      1,
      Math.floor(
        assertLimitRequired(options?.maxTotal, {
          name: 'maxTotal',
          className: 'PowerBufferPool',
          min: 1,
          fallback: 256,
        })
      )
    );
    /** @type {Map<number, Uint8Array[]>} */
    this._pools = new Map();
    for (const b of this._buckets) this._pools.set(b, []);
    this._total = 0;
    this._disposed = false;
    this._acquires = 0;
    this._reuses = 0;
    this._releases = 0;
    this._drops = 0;
  }

  /** @returns {number[]} The configured buckets, ascending. */
  get buckets() {
    return [...this._buckets];
  }

  /** @returns {number} Buffers currently retained. */
  get pooled() {
    return this._total;
  }

  /**
   * Pick the smallest bucket that fits `size`, or `null` when no bucket fits
   * (the request is larger than every configured bucket).
   * @param {number} size
   * @returns {number|null}
   * @private
   */
  _bucketFor(size) {
    for (const b of this._buckets) {
      if (b >= size) return b;
    }
    return null;
  }

  /**
   * Acquire a buffer of at least `size` bytes.
   * @param {number} [size=0]
   * @returns {Uint8Array}
   */
  acquire(size = 0) {
    if (this._disposed) throw new Error('PowerBufferPool: pool is disposed');
    const n = Math.max(0, Math.floor(Number(size) || 0));
    if (!Number.isFinite(n)) throw new TypeError('PowerBufferPool.acquire: size must be finite');
    this._acquires += 1;
    const bucket = this._bucketFor(n === 0 ? 1 : n);
    if (bucket === null) {
      // Larger than any bucket: allocate exactly and do not pool.
      return new Uint8Array(n);
    }
    const pool = this._pools.get(bucket);
    if (pool && pool.length > 0) {
      this._reuses += 1;
      const buf = pool.pop();
      if (!buf) return new Uint8Array(bucket);
      this._total -= 1;
      // Zero the reused buffer so stale bytes cannot leak between callers.
      buf.fill(0);
      return buf;
    }
    return new Uint8Array(bucket);
  }

  /**
   * Return a buffer to the pool. Returns `true` when retained, `false` when
   * dropped (wrong size, pool full, or disposed).
   * @param {Uint8Array} buf
   * @returns {boolean}
   */
  release(buf) {
    if (this._disposed) return false;
    if (!(buf instanceof Uint8Array)) return false;
    this._releases += 1;
    const bucket = this._buckets.find((b) => b === buf.byteLength);
    if (bucket === undefined) {
      this._drops += 1;
      return false;
    }
    const pool = this._pools.get(bucket);
    if (!pool || pool.length >= this._maxPerBucket || this._total >= this._maxTotal) {
      this._drops += 1;
      return false;
    }
    pool.push(buf);
    this._total += 1;
    return true;
  }

  /**
   * Point-in-time statistics.
   * @returns {{buckets:number[], pooled:number, maxPerBucket:number, maxTotal:number, acquires:number, reuses:number, releases:number, drops:number, reuseRate:number}}
   */
  stats() {
    return {
      buckets: [...this._buckets],
      pooled: this._total,
      maxPerBucket: this._maxPerBucket,
      maxTotal: this._maxTotal,
      acquires: this._acquires,
      reuses: this._reuses,
      releases: this._releases,
      drops: this._drops,
      reuseRate: this._acquires > 0 ? this._reuses / this._acquires : 0,
    };
  }

  /**
   * Release all retained buffers.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const pool of this._pools.values()) pool.length = 0;
    this._pools.clear();
    this._total = 0;
  }

  /** @returns {void} */
  [Symbol.dispose]() {
    this.dispose();
  }

  /** @returns {Promise<void>} */
  async [Symbol.asyncDispose]() {
    this.dispose();
  }
}
