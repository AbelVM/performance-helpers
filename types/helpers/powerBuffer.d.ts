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
export function isArrayBuffer(value: unknown): value is ArrayBuffer;
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
export function isSharedArrayBuffer(buf: unknown): boolean;
export function o2u8(obj: any, preStringified?: string): Uint8Array;
export function u82o(buf: ArrayBuffer | ArrayBufferView): any;
export function o2b(obj: any): ArrayBuffer;
export function b2o(buf: ArrayBuffer | ArrayBufferView): any;
export type BufferEncoder = import("./jsdoc-types.js").BufferEncoder;
export type BufferDecoder = import("./jsdoc-types.js").BufferDecoder;
