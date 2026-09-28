/**
 * Stop waiting for a promise when a signal aborts.
 *
 * The *operation* keeps running. `Promise.race` is the wrong tool for that,
 * because it is indistinguishable from actually cancelling: the inner promise
 * still settles, its work still happens, and the only thing that changes is
 * that nobody is listening. Here that is deliberate and explicit - the
 * underlying promise is kept alive, only the returned view is abandoned.
 *
 * This is the "cancellable wait, not cancellable operation" contract, and it
 * is the one the queue-shaped helpers in this library need. A `PowerPool` drain
 * that stopped dispatching work because someone stopped watching would be
 * wrong; a `PowerPool` drain whose promise rejects while the pool keeps serving
 * its other callers is right.
 *
 * @param {Promise<any>} promise - The wait to abandon on abort.
 * @param {AbortSignal|null|undefined} signal - Aborts the wait, not the work.
 * @returns {Promise<any>} Resolves/rejects with `promise`, or rejects with an
 *   `AbortError` if the signal fires first.
 * @private
 */
export function raceWithAbort(promise: Promise<any>, signal: AbortSignal | null | undefined): Promise<any>;
/**
 * The rejection value for an aborted wait.
 *
 * Prefers `signal.reason` when it is an Error, so a caller that aborted with
 * `controller.abort(new MyError())` gets their own error back. Otherwise a
 * `DOMException` with `name: 'AbortError'`, which is what `err.name ===
 * 'AbortError'` checks expect - and what a stripped runtime without
 * `DOMException` gets as a plain named Error.
 *
 * @param {AbortSignal} signal
 * @returns {Error}
 */
export function abortReason(signal: AbortSignal): Error;
