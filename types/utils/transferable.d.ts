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
export function markUntransferable(buffer: ArrayBufferLike | null | undefined): boolean;
/**
 * Whether {@link markUntransferable} can do anything on this platform.
 *
 * Exposed for the guide and for a test that asserts the *documented* difference between a
 * marked and an unmarked platform, rather than leaving that difference to be discovered on
 * a browser.
 *
 * @returns {boolean}
 */
export function canMarkUntransferable(): boolean;
