/**
 * Measure a synchronous function's execution duration.
 *
 * If `fn` is a function it will be invoked synchronously; otherwise the
 * provided value is treated as the result and returned immediately. The
 * returned object contains the `result` plus `ms`, `start`, and `end`
 * timestamps measured with `nowMs()`.
 *
 * If the invoked function throws, the thrown error will be augmented with
 * a `durationMs` property (elapsed time until the throw) before being
 * re-thrown to the caller.
 *
 * @param {Function|any} fn - Function to execute or a direct value.
 * @returns {{result:any, ms:number, start:number, end:number}} The result and timing.
 * @throws {*} Re-throws any error thrown by `fn` after attaching `durationMs`.
 */
export function measureSync(fn: Function | any): {
    result: any;
    ms: number;
    start: number;
    end: number;
};
/**
 * Measure an async function or promise's execution duration.
 *
 * If `fn` is a function it will be invoked and its returned Promise/value
 * awaited; if `fn` is already a Promise or a plain value it will be awaited
 * directly. Resolves with an object containing `result`, `ms`, `start`, and
 * `end` timestamps measured with `nowMs()`.
 *
 * On rejection the thrown error will be augmented with `durationMs` and
 * re-thrown to the caller.
 *
 * @param {Function|Promise|any} fn - Async function, Promise, or direct value.
 * @returns {Promise<{result:any, ms:number, start:number, end:number}>} Promise resolving to result and timing.
 * @throws {*} Re-throws any rejection from `fn` after attaching `durationMs`.
 */
export function measureAsync(fn: Function | Promise<any> | any): Promise<{
    result: any;
    ms: number;
    start: number;
    end: number;
}>;
export function nowMs(): number;
export default nowMs;
