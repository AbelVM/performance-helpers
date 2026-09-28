import { formatErrorObj, normalizeError } from '../utils/errors.js';
import { nowMs } from '../utils/now.js';

// Reuse common textual level labels from a single frozen object to avoid
// repeated literal allocations in hot logging paths.
const LEVEL_LABELS = Object.freeze({
  error: 'error',
  warn: 'warn',
  info: 'info',
  log: 'log',
  debug: 'debug',
  table: 'table',
});

const getConsole = () => {
  if (typeof globalThis !== 'undefined' && globalThis?.console) {
    return globalThis.console;
  }
  if (typeof self !== 'undefined' && self?.console) {
    return self.console;
  }
  if (typeof window !== 'undefined' && window?.console) {
    return window.console;
  }
  if (typeof global !== 'undefined' && global?.console) {
    return global.console;
  }
  return null;
};

const ROOT_CONSOLE = getConsole();

/**
 * Whether a named console method exists and is callable on the captured root
 * console. Narrowed once because `_emit` dispatches through the name, and the
 * test is repeated at four call sites.
 *
 * @param {PowerLoggerConsoleMethod} method
 * @returns {boolean}
 */
function hasConsoleMethod(method) {
  return typeof ROOT_CONSOLE?.[method] === 'function';
}

/**
 * Call a console method that {@link hasConsoleMethod} has already accepted.
 *
 * A separate function because `ROOT_CONSOLE` is nullable and a boolean helper
 * cannot narrow the receiver: optional chaining in the test and a bare call
 * here are two different expressions to TypeScript, and the call site is
 * guarded by the test.
 *
 * @param {PowerLoggerConsoleMethod} method
 * @param {...any} args
 * @returns {void}
 */
function consoleCall(method, ...args) {
  const target = ROOT_CONSOLE;
  if (!target || typeof target[method] !== 'function') return;
  target[method](...args);
}

/**
 * Coerce a debug level to a number, the way `setDebugLevel` has always done it.
 *
 * Kept out of `setDebugLevel` itself for two reasons. It keeps the public
 * signature honest - the method is documented as taking a `number` in 0..3, and
 * that is what a consumer should pass - and it gives the `instanceof` checks a
 * parameter that is genuinely `unknown`: `instanceof` needs an object operand,
 * and a `number` parameter narrows to `never` after the primitive branches.
 *
 * `powerLogger.branches.test.js` covers the boxed-primitive and throwing-
 * `toString` cases, so the coercion is behaviour, not accident. A value that
 * does not produce a finite number yields `NaN`, which the caller turns into
 * level 0.
 *
 * @param {unknown} level
 * @returns {number}
 */
function coerceDebugLevel(level) {
  if (typeof level === 'number') return level;
  if (typeof level === 'string' || typeof level === 'boolean') return Number(level);
  if (level instanceof Number || level instanceof String || level instanceof Boolean) {
    return Number(level.valueOf());
  }
  return NaN;
}

// Safely serialize an object to JSON for logging. Handles circular
// references and common non-serializable types (BigInt, Symbol, Function)
// by providing reasonable string fallbacks. Attempts a fast `JSON.stringify`
// first and falls back to a replacer-based pass when that fails.
//
/**
 * @param {*} obj - Any value. `JSON.stringify` yields `undefined` for a
 *   function or `undefined`, so the result is not always a string.
 * @returns {string|undefined}
 */
function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    try {
      const seen = typeof WeakSet === 'function' ? new WeakSet() : new Set();
      return JSON.stringify(obj, function (k, v) {
        if (v && typeof v === 'object') {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        if (typeof v === 'function') return `[Function: ${v.name || 'anonymous'}]`;
        if (typeof v === 'symbol') return String(v);
        if (typeof v === 'bigint') return v.toString() + 'n';
        return v;
      });
    } catch (e2) {
      try {
        return String(obj);
      } catch (e3) {
        return '[Unserializable]';
      }
    }
  }
}

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
  constructor(level = 0, options = {}) {
    this._debugLevel = 0;
    this._counters = Object.create(null);
    this._format = options?.format || 'text';
    this.name = options?.name || null;
    this._formatter = typeof options?.formatter === 'function' ? options.formatter : null;
    this._output = typeof options?.output === 'function' ? options.output : null;
    this.setDebugLevel(level);
  }

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
  setDebugLevel(level) {
    const n = coerceDebugLevel(level);
    this._debugLevel = Number.isFinite(n) && n >= 0 ? Math.max(0, Math.min(3, Math.floor(n))) : 0;
  }

  /**
   * Get the current debug level.
   * @returns {number} The configured debug level (0..3)
   */
  getDebugLevel() {
    return this._debugLevel;
  }

  /**
   * Determine whether the current debug level is >= `level`.
   * @param {number} [level=1]
   * @returns {boolean}
   */
  isDebugLevel(level = 1) {
    return Number(this._debugLevel) >= Number(level || 1);
  }

  /**
   * Convenience: whether any debugging is enabled (level > 0).
   * @returns {boolean}
   */
  isDebug() {
    return this.isDebugLevel(1);
  }

  /**
   * Normalize log arguments by lazily evaluating function values.
   * @private
   * @param {any[]} args
   * @returns {any[]}
   */
  _resolveLogArgs(args) {
    return args.map((a) => {
      if (typeof a === 'function') {
        try {
          return a();
        } catch (e) {
          return e;
        }
      }
      return a;
    });
  }

  /**
   * Internal helper to emit logs with unified JSON/text formatting.
   * @private
   * @param {number} threshold - minimum debug level required to emit
   * @param {PowerLoggerConsoleMethod} consoleMethod - name of console method to call (error, warn, info, log, debug)
   * @param {string} levelLabel - textual level label for JSON mode
   * @param {any[]} args - original arguments array
   * @param {PowerLoggerEmitOptions} [opts]
   */
  _emit(threshold, consoleMethod, levelLabel, args, opts = {}) {
    if (!this.isDebugLevel(threshold)) return;
    const resolved = this._resolveLogArgs(args);

    // Build a structured payload that output() handlers can use.
    const msg = opts.msgArray ? resolved : resolved.length === 1 ? resolved[0] : resolved;
    /** @type {PowerLoggerPayload} */
    let payload = { level: levelLabel, msg, ts: nowMs(), format: this._format };
    if (this.name) payload.name = this.name;

    // Allow the optional formatter to transform the payload first.
    if (this._formatter) {
      try {
        const formatted = this._formatter(payload);
        if (formatted !== undefined && formatted !== null) {
          if (typeof formatted === 'string') {
            // If formatter returns a string, prefer to emit the string
            // directly to the transport or console rather than wrapping
            // it in a JSON envelope.
            if (this._output) {
              try {
                this._output(formatted);
              } catch (e) {
                // A throwing sink must not take the logger down with it.
                this._emitSinkError(e);
              }
              return;
            }
            // No output transport: write string directly to the root console.
            consoleCall(consoleMethod, formatted);
            return;
          }
          // Non-string formatted payload becomes the new payload object
          payload = formatted;
        }
      } catch (e) {
        // ignore formatter errors and fall back to original payload
      }
    }

    // If an `output` transport is provided, hand the structured payload to it
    // and do not perform console output. This lets consumers redirect logs
    // to test spies, files, or remote collectors.
    if (this._output) {
      try {
        this._output(payload);
      } catch (e) {
        // swallow to avoid throwing from logging
      }
      return;
    }

    // Fall back to console methods when no output transport is provided.
    if (!hasConsoleMethod(consoleMethod)) return;
    if (this._format === 'json') {
      try {
        const out = typeof payload === 'string' ? payload : safeStringify(payload);
        consoleCall(consoleMethod, out);
      } catch (e) {
        // fallback: attempt plain console with resolved args
        try {
          consoleCall(consoleMethod, ...(Array.isArray(resolved) ? resolved : [resolved]));
        } catch (e2) {
          /* swallow logging failures */
        }
      }
    } else {
      consoleCall(consoleMethod, ...resolved);
    }
  }

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
  _emitSinkError(err) {
    try {
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error('PowerLogger: log sink threw', err);
      }
    } catch (_) {
      // Both sinks failed; there is nowhere left to report this.
    }
  }

  /**
   * Log an error-level message when debug level is >= 1.
   * Accepts values or functions (lazy evaluated).
   *
   * Errors are formatted on the way through rather than left to the transport,
   * so a sink always receives a readable message instead of an `Error` object.
   *
   * @param {...any} args
   * @returns {void}
   */
  error(...args) {
    const formatted = args.map((a) => {
      try {
        if (a?.error) return formatErrorObj(a);
        if (a instanceof Error || (a && typeof a === 'object'))
          return formatErrorObj(normalizeError(a));
      } catch (e) {
        /* ignore formatting failures */
      }
      return a;
    });
    this._emit(1, 'error', LEVEL_LABELS.error, formatted);
  }

  /**
   * Log a warning-level message when debug level is >= 2.
   * @param {...any} args
   * @returns {void}
   */
  warn(...args) {
    this._emit(2, 'warn', LEVEL_LABELS.warn, args);
  }

  /**
   * Log an info-level message when debug level is >= 3.
   * @param {...any} args
   * @returns {void}
   */
  info(...args) {
    this._emit(3, 'info', LEVEL_LABELS.info, args);
  }

  /**
   * Log a verbose message when debug level is >= 3.
   * @param {...any} args
   * @returns {void}
   */
  log(...args) {
    this._emit(3, 'log', LEVEL_LABELS.log, args);
  }

  /**
   * Log using `console.debug` when level >= 3 (alias for verbose debug output).
   * Accepts values or functions (lazy evaluated).
   * Supports JSON mode similar to other methods.
   * @param {...any} args
   * @returns {void}
   */
  debug(...args) {
    this._emit(3, 'debug', LEVEL_LABELS.debug, args);
  }

  /**
   * Display tabular data. Uses `console.table` when available.
   * In JSON mode emits `{ level: 'table', msg: args, ts }` where `msg` is an array of arguments.
   * @param {...any} args
   * @returns {void}
   */
  table(...args) {
    if (!this.isDebugLevel(3) || !ROOT_CONSOLE) return;
    // For JSON mode reuse the _emit helper but force the message to be an array
    if (this._format === 'json') {
      this._emit(3, 'log', LEVEL_LABELS.table, args, { msgArray: true });
      return;
    }
    const resolved = this._resolveLogArgs(args);
    if (typeof ROOT_CONSOLE.table === 'function') ROOT_CONSOLE.table(...resolved);
    else if (typeof ROOT_CONSOLE.log === 'function') ROOT_CONSOLE.log(...resolved);
  }

  /**
   * Increment an internal named counter (no-op when debug is disabled).
   * Useful for lightweight instrumentation in tests.
   * @param {string} name
   * @returns {void}
   */
  incrementCounter(name) {
    if (!this.isDebug()) return;
    const k = String(name || '');
    if (!k) return;
    this._counters[k] = (this._counters[k] || 0) + 1;
  }

  /**
   * Read counters as a plain object snapshot.
   * @returns {Record<string,number>}
   */
  getDebugCounters() {
    return Object.assign({}, this._counters);
  }

  /**
   * Reset all internal counters (test helper).
   * @returns {void}
   */
  resetDebugCounters() {
    this._counters = Object.create(null);
  }
}
