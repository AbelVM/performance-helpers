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
export function isRegExp(value: unknown): boolean;
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
export function isDate(value: unknown): boolean;
export function o2u8(obj: any, preStringified?: string): Uint8Array;
export function u82o(buf: ArrayBuffer | ArrayBufferView): any;
export function o2b(obj: any): ArrayBuffer;
export function b2o(buf: ArrayBuffer | ArrayBufferView): any;
export type BufferEncoder = import("./jsdoc-types.js").BufferEncoder;
export type BufferDecoder = import("./jsdoc-types.js").BufferDecoder;
