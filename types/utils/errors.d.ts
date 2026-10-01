/**
 * Whether `value` is an `Error`, across realms where the platform can say so.
 *
 * `instanceof` compares against *this realm's* `Error.prototype`, so it is
 * `false` for an error created in another `vm` context, another realm, or an
 * iframe - even though the value is exactly what the caller means. Every site
 * in this library that narrows with `instanceof Error` is therefore wrong for a
 * caller who hands us an error from somewhere else, and the failure mode is a
 * *substitute* rather than a diagnostic: `abortReason()` replaces the caller's
 * error with a fresh `AbortError`, so the reason they aborted with is silently
 * discarded.
 *
 * `Error.isError()` (ES2026, V8 13.6 / Node 24) is a brand check on the
 * `[[ErrorData]]` internal slot and is realm-independent. **It does not exist
 * on this library's declared floor** - `engines.node` is `>=22.12.0` (V8 12.4)
 * and CI runs 22.12 - so the capability is probed once here, at module load,
 * rather than assumed at each call site. On a runtime without it the
 * `instanceof` fallback preserves today's behaviour exactly, which is why this
 * is a strict improvement rather than a raised floor.
 *
 * Two differences from `instanceof` change the answer in the *other* direction,
 * and both are correct: `Object.create(Error.prototype)` has the prototype but
 * not the brand (`instanceof` says `true`, this says `false`), and a
 * cross-realm error has the brand but not this realm's prototype (`instanceof`
 * says `false`, this says `true`).
 *
 * Declared as a **type predicate** rather than returning plain `boolean`.
 * That is not decoration: without it `tsc` cannot narrow at the call site, and
 * the first caller to rely on narrowing introduced two type errors -
 * `options.reason instanceof Error ? reason : new Error(...)` in
 * `PowerBulkhead#reset` widened to `string | Error | undefined` at the merge,
 * because nothing told the checker the true branch was an `Error`. It is also
 * strictly more useful than `boolean` at every other site.
 *
 * @param {unknown} value - Any value, including a non-object.
 * @returns {value is Error} `true` if `value` is an `Error` object.
 */
export function isError(value: unknown): value is Error;
/**
 * Normalize various error shapes into a canonical error object used
 * across helpers.
 *
 * If `err` is falsy or not an object a minimal error object is returned
 * with the provided `defaultCode` and the stringified value as the
 * `message` when available.
 *
 * @param {any} err - The incoming error value (Error instance, object, or any).
 * @param {string} [defaultCode='ERR_ITEM'] - Fallback error code when none present.
 * @returns {{error: true, code: string, message: string|undefined, stack: string|undefined}}
 */
export function normalizeError(err: any, defaultCode?: string): {
    error: true;
    code: string;
    message: string | undefined;
    stack: string | undefined;
};
/**
 * Convert a normalized error object into a compact human-readable string.
 * If the value is not a normalized error it will be stringified.
 *
 * Examples:
 * - `{ error: true, code: 'ERR_X', message: 'oops' }` -> `"ERR_X: oops"`
 * - any other value -> `String(value)`
 *
 * @param {any} errObj - A normalized error object (or any value).
 * @returns {string} Human readable error string.
 */
export function formatErrorObj(errObj: any): string;
/**
 * The rejection a queue-bound helper produces when it refuses to queue.
 *
 * ## Why this exists
 *
 * `PowerPermitGate` and `PowerBulkhead` both rejected a full queue with a bare
 * `new Error('… queue is full')`, so `err.code` was `undefined` and the only way
 * to distinguish the condition was to match on message text. Meanwhile the pool
 * had published `ERR_POOL_QUEUE_FULL` for the identical situation, and
 * `guides/errors.md` argues at length that the difference between *shedding load*
 * and *failing* is exactly what a code is for — retrying a refused call is what
 * filled the queue.
 *
 * Three classes, one documented code, two unlabelled, is a shape a caller has to
 * remember rather than branch on. This gives the two queue-bound helpers the same
 * code as the pool, from one definition, so the string is written once.
 *
 * Deliberately the **pool's** code rather than a new one: the condition is the
 * same (no capacity to accept, shed the load) and a caller handling
 * `ERR_POOL_QUEUE_FULL` already has the right response. Inventing
 * `ERR_QUEUE_FULL` would have made them branch in three places instead of one.
 *
 * @param {string} className - The helper refusing, for the message.
 * @param {number} queueCapacity - The configured bound that was reached.
 * @returns {Error & {code: 'ERR_QUEUE_FULL', queueCapacity: number}} Error with
 *   a stable `code` and the bound that was hit, so a caller does not parse text.
 */
export function queueFullError(className: string, queueCapacity: number): Error & {
    code: "ERR_QUEUE_FULL";
    queueCapacity: number;
};
