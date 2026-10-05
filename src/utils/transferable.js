/**
 * `markAsUntransferable`, where the platform has it, and a documented no-op where it does not.
 *
 * Node 21 added `markAsUntransferable(buffer)` from `node:worker_threads`, and the platform
 * *enforces* the marker: a marked `ArrayBuffer` listed for transfer is refused instead of
 * being detached. This library's Node floor is `>=22.12.0`, so it is present on every
 * supported Node — and absent in every browser, which is why this is feature-detected
 * rather than imported.
 *
 * **Measured, and the first draft of this comment had it wrong.** I wrote that a marked
 * buffer throws `DataCloneError`; it does not. On Node 24.18, `structuredClone(x, {transfer:
 * [marked]})` throws a **`DOMException` reading `Cannot transfer object of unsupported
 * type`**, while the same call on an unmarked buffer succeeds and leaves it at
 * `byteLength === 0`. The *mechanism* is the same on both paths — the buffer becomes
 * un-transferable, not detached — but the error type is an implementation detail of the
 * platform, so nothing here should assert on it.
 *
 * ## Why a marker rather than a check
 *
 * The alternative is a **detached-buffer pre-check** before transferring: read
 * `ArrayBuffer.prototype.detached` and skip anything already detached. That catches the
 * *second* transfer and not the first, which is the one that matters — after the first
 * transfer the cache entry is a zero-length husk, the next `get` on that key returns it,
 * and the payload silently arrives at the worker empty. A marker moves the failure to the
 * call site that made the mistake, and it is the platform doing the enforcing rather than
 * this library's own bookkeeping.
 *
 * ## What this does not do
 *
 * It does not make a marked buffer immutable. `set()` on the view still works, the bytes
 * are still shared, and a caller that *copies* the buffer rather than transferring it is
 * unaffected. It makes one specific mistake loud: listing the buffer for transfer.
 */

/**
 * Whether the platform provides `markAsUntransferable`.
 *
 * Read from `node:worker_threads` rather than `globalThis`, because it is a module export
 * and not a global. A **static import would be wrong here**: bundlers resolve
 * `node:worker_threads` for browser builds and fail, which is the same reason
 * `powerEventLoopMonitor.js` resolves `node:perf_hooks` lazily.
 *
 * @type {?function(ArrayBuffer):void}
 */
let impl = null;
let probed = false;

/**
 * Mark an `ArrayBuffer` so the platform refuses to transfer it.
 *
 * **Every failure mode here is silent by design, and that is the whole contract.** A browser
 * has no such API; a `SharedArrayBuffer` is not markable; a buffer that is already marked is
 * a no-op. None of those is a reason to fail a `postMessage`, so none of them throws.
 *
 * The one case worth noticing is a **non-`ArrayBuffer` view target**: `view.buffer` is
 * always an `ArrayBuffer` for a typed array over one, so that cannot happen here, but a
 * caller passing a `DataView` over a `SharedArrayBuffer` could and the guard absorbs it.
 *
 * @param {ArrayBufferLike|null|undefined} buffer - Usually `view.buffer`.
 * @returns {boolean} `true` if the buffer is marked or the platform has no marker to apply.
 */
export function markUntransferable(buffer) {
  if (!buffer || typeof buffer !== 'object') return false;
  // A SharedArrayBuffer cannot be transferred in the first place, so there is nothing to
  // protect and `markAsUntransferable` would throw a TypeError on it.
  if (typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer) {
    return false;
  }
  if (!probed) {
    probed = true;
    try {
      const mod = globalThis.process?.getBuiltinModule?.('node:worker_threads');
      const fn = mod?.markAsUntransferable ?? null;
      impl = typeof fn === 'function' ? fn : null;
    } catch {
      impl = null;
    }
  }
  if (!impl) return false;
  try {
    impl(/** @type {ArrayBuffer} */ (buffer));
    return true;
  } catch {
    // Already marked is the common one and is not a problem. Anything else — a detached
    // buffer, a cross-realm one — is also not worth failing a send over, because the
    // detached pre-check in `powerPool.js` is the thing that actually reports those.
    return false;
  }
}

/**
 * Whether {@link markUntransferable} can do anything on this platform.
 *
 * Exposed for the guide and for a test that asserts the *documented* difference between a
 * marked and an unmarked platform, rather than leaving that difference to be discovered on
 * a browser.
 *
 * @returns {boolean}
 */
export function canMarkUntransferable() {
  // Probe without marking: the cheap answer is worth more than a second call site that
  // has to remember to check.
  markUntransferable(new ArrayBuffer(0));
  return impl !== null;
}
