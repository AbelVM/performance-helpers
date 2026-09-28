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
export function raceWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    /**
     * @param {any} [value]
     * @returns {void}
     */
    const onSettle = (value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    /**
     * @param {any} err
     * @returns {void}
     */
    const onFail = (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    };
    /**
     * @returns {void}
     */
    const onAbort = () => {
      // Deliberately does not touch `promise`. It is already handled - it was
      // created before this call - and rejecting it here would break the other
      // callers sharing it. Only this view is abandoned.
      reject(abortReason(signal));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(onSettle, onFail);
  });
}

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
export function abortReason(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  try {
    return new DOMException('The operation was aborted', 'AbortError');
  } catch {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    return err;
  }
}
