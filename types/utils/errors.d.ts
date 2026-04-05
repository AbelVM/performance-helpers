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
