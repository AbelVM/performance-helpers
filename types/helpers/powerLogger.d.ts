/**
 * PowerLogger
 *
 * Centralized debug logging and lightweight in-memory counters used for
 * runtime instrumentation and tests. Instances manage a numeric debug
 * verbosity level (0-3) which gates which console methods are invoked.
 *
 * Debug levels:
 * - 0: disabled
 * - 1: errors only
 * - 2: errors and warnings
 * - 3: info and verbose logs
 *
 * Example:
 * ```javascript
 * import { PowerLogger } from './powerLogger.js'
 * const logger = new PowerLogger(2)
 * logger.warn('Something notable')
 * logger.incrementCounter('my-event')
 * ```
 *
 * @class PowerLogger
 */
/**
 * @typedef {import('./jsdoc-types.js').PowerLoggerOptions} PowerLoggerOptions
 * @typedef {import('./jsdoc-types.js').PowerLoggerPayload} PowerLoggerPayload
 * @typedef {import('./jsdoc-types.js').PowerLoggerEmitOptions} PowerLoggerEmitOptions
 * @typedef {import('./jsdoc-types.js').PowerLoggerConsoleMethod} PowerLoggerConsoleMethod
 */
export class PowerLogger {
    /**
     * Create a PowerLogger instance.
     * @param {number} [level=0] Initial debug level (0..3)
     * @param {PowerLoggerOptions} [options] - The `PowerLoggerOptions` typedef
     *   already existed and already declared `name`/`formatter`/`output`; the
     *   constructor was taking a bare `{Object}` instead, which is why reading
     *   any of them was an error and a custom sink needed a cast.
     */
    constructor(level?: number, options?: PowerLoggerOptions);
    _debugLevel: number;
    _counters: Map<any, any>;
    _countersDropped: number;
    _maxCounters: number;
    _format: "json" | "text";
    name: string | null;
    _formatter: ((payload: import("./jsdoc-types.js").PowerLoggerPayload) => string | import("./jsdoc-types.js").PowerLoggerPayload | null) | null;
    _output: ((payload: import("./jsdoc-types.js").PowerLoggerPayload | string) => void) | null;
    /**
     * Set the global debug level.
     *
     * Coerced with `Number()` and clamped to 0..3; anything that does not coerce
     * to a finite non-negative number leaves the level at 0. See
     * {@link coerceDebugLevel} for what the coercion accepts.
     *
     * @param {number} level - Integer in range 0..3
     * @returns {void}
     */
    setDebugLevel(level: number): void;
    /**
     * Get the current debug level.
     * @returns {number} The configured debug level (0..3)
     */
    getDebugLevel(): number;
    /**
     * Determine whether the current debug level is >= `level`.
     * @param {number} [level=1]
     * @returns {boolean}
     */
    isDebugLevel(level?: number): boolean;
    /**
     * Convenience: whether any debugging is enabled (level > 0).
     * @returns {boolean}
     */
    isDebug(): boolean;
    /**
     * Normalize log arguments by lazily evaluating function values.
     * @private
     * @param {any[]} args
     * @returns {any[]}
     */
    private _resolveLogArgs;
    /**
     * Internal helper to emit logs with unified JSON/text formatting.
     * @private
     * @param {number} threshold - minimum debug level required to emit
     * @param {PowerLoggerConsoleMethod} consoleMethod - name of console method to call (error, warn, info, log, debug)
     * @param {string} levelLabel - textual level label for JSON mode
     * @param {any[]} args - original arguments array
     * @param {PowerLoggerEmitOptions} [opts]
     */
    private _emit;
    /**
     * Report a failure raised by a user-supplied log sink.
     *
     * A sink that throws must not be able to take the logger - and therefore the
     * pool, cache or circuit that owns it - down with it, but the failure still
     * has to be visible somewhere. Escalate to `console.error` once, guarded, and
     * give up if that fails too.
     *
     * @param {any} err - The value thrown by the sink.
     * @returns {void}
     */
    _emitSinkError(err: any): void;
    /**
     * Log an error-level message when debug level is >= 1.
     * Accepts values or functions (lazy evaluated).
     *
     * Errors are formatted on the way through rather than left to the transport,
     * so a sink always receives a readable message instead of an `Error` object.
     *
     * The narrowing is `isError()`, and the second clause is **not** redundant -
     * it is what decides plain objects, which are formatted by `normalizeError`
     * like errors are.
     *
     * It was previously `a instanceof Error || (a && typeof a === 'object')`, and
     * that object clause is why this method was **already** realm-safe: a
     * cross-realm `Error` fails `instanceof` but is `typeof 'object'`, and
     * `normalizeError` reads only `.code` / `.message` / `.stack`, all of which a
     * cross-realm error has. So the row's premise - that `powerLogger` was
     * realm-fragile - is false, and was verified by logging a `vm`-created
     * `TypeError` and a local one and diffing the emitted payloads (identical
     * once `ts` is stripped) *before* any edit.
     *
     * The `instanceof` half is changed anyway because `isError()` is the honest
     * test, it is what the other sites use, and leaving one `instanceof` behind
     * invites the reading that this method is realm-fragile when it never was.
     *
     * @param {...any} args
     * @returns {void}
     */
    error(...args: any[]): void;
    /**
     * Log a warning-level message when debug level is >= 2.
     * @param {...any} args
     * @returns {void}
     */
    warn(...args: any[]): void;
    /**
     * Log an info-level message when debug level is >= 3.
     * @param {...any} args
     * @returns {void}
     */
    info(...args: any[]): void;
    /**
     * Log a verbose message when debug level is >= 3.
     * @param {...any} args
     * @returns {void}
     */
    log(...args: any[]): void;
    /**
     * Log using `console.debug` when level >= 3 (alias for verbose debug output).
     * Accepts values or functions (lazy evaluated).
     * Supports JSON mode similar to other methods.
     * @param {...any} args
     * @returns {void}
     */
    debug(...args: any[]): void;
    /**
     * Display tabular data. Uses `console.table` when available.
     * In JSON mode emits `{ level: 'table', msg: args, ts }` where `msg` is an array of arguments.
     * @param {...any} args
     * @returns {void}
     */
    table(...args: any[]): void;
    /**
     * Increment an internal named counter (no-op when debug is disabled).
     * Useful for lightweight instrumentation in tests.
     * @param {string} name
     * @returns {void}
     */
    incrementCounter(name: string): void;
    /**
     * Read counters as a plain object snapshot.
     * @returns {Record<string,number>}
     */
    getDebugCounters(): Record<string, number>;
    /**
     * How many counters have been dropped because the cap was reached.
     *
     * Exists because a silent cap is a cap nobody can trust: a logger quietly
     * discarding keys looks identical to a logger nobody incremented, and the
     * difference matters when you are reading the snapshot to work out what happened.
     * A plain number rather than a field on the snapshot, because the snapshot is
     * `Record<string, number>` and a reserved key would collide with a counter a
     * caller legitimately named `dropped`.
     *
     * @returns {number}
     */
    getDebugCountersDropped(): number;
    /**
     * Reset all internal counters (test helper).
     *
     * The drop count is reset with them. Leaving it would mean a fresh
     * `getDebugCountersDropped()` reported drops from a previous life, which is the
     * "counter that is not reset when everything else is" bug this repo has hit
     * before on `PowerCache._rejectedAdmission`.
     *
     * @returns {void}
     */
    resetDebugCounters(): void;
}
export type PowerLoggerOptions = import("./jsdoc-types.js").PowerLoggerOptions;
export type PowerLoggerPayload = import("./jsdoc-types.js").PowerLoggerPayload;
export type PowerLoggerEmitOptions = import("./jsdoc-types.js").PowerLoggerEmitOptions;
export type PowerLoggerConsoleMethod = import("./jsdoc-types.js").PowerLoggerConsoleMethod;
