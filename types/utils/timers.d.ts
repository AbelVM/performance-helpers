/**
 * @typedef {object} TimerOptions
 * @property {boolean} [keepProcessAlive=false] - When `true`, skip the
 *   `unref()` call so the timer keeps the Node.js event loop alive.
 */
/**
 * Schedule a one-shot timer that does not keep the Node.js process alive.
 *
 * @param {Function} fn - Callback invoked after the delay.
 * @param {number} ms - Delay in milliseconds.
 * @param {TimerOptions} [options] - Timer options.
 * @returns {any} The underlying timer handle (`Timeout` in Node.js, a number
 *   in browsers). Usable with `clearTimeout`.
 */
export function setSafeTimeout(fn: Function, ms: number, options?: TimerOptions): any;
/**
 * Schedule a repeating timer that does not keep the Node.js process alive.
 *
 * @param {Function} fn - Callback invoked on every tick.
 * @param {number} ms - Period in milliseconds.
 * @param {TimerOptions} [options] - Timer options.
 * @returns {any} The underlying timer handle. Usable with `clearInterval`.
 */
export function setSafeInterval(fn: Function, ms: number, options?: TimerOptions): any;
export default setSafeTimeout;
export type TimerOptions = {
    /**
     * - When `true`, skip the
     * `unref()` call so the timer keeps the Node.js event loop alive.
     */
    keepProcessAlive?: boolean | undefined;
};
