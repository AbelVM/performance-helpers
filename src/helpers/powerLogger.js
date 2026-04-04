/**
 * Centralized debug helper for the performance-helpers library.
 *
 * Provides a runtime gate for console messages and an internal
 * counter store useful for lightweight instrumentation in tests.
 * Call `setDebugLevel(level)` during initialization to control verbosity.
 *
 * Debug levels:
 *  - 0: disabled
 *  - 1: errors only
 *  - 2: errors and warnings
 *  - 3: all messages (info/log)
 *
 * Usage example:
 * ```javascript
 * import { PowerLogger } from './powerLogger.js'
 * const logger = new PowerLogger(2)
 * logger.warn('something notable')
 * ```
 *
 *
 */

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
export class PowerLogger {
  /**
   * Create a PowerLogger instance.
   * @param {number} [level=0] Initial debug level (0..3)
   * @param {Object} [options]
   * @param {'text'|'json'} [options.format='text'] Output format. When 'json', logger emits JSON.stringify({ level, msg, ts }).
   */
  constructor(level = 0, options = {}) {
    this._debugLevel = 0;
    this._counters = Object.create(null);
    this._format = (options && options.format) || 'text';
    this.name = (options && options.name) || null;
    this._formatter = options && typeof options.formatter === 'function' ? options.formatter : null;
    this._output = options && typeof options.output === 'function' ? options.output : null;
    this.setDebugLevel(level);
  }

  /**
   * Set the global debug level.
   * @param {number} level - Integer in range 0..3
   * @returns {void}
   */
  setDebugLevel(level) {
    try {
      const n = Number(level);
      this._debugLevel = Number.isFinite(n) && n >= 0 ? Math.max(0, Math.min(3, Math.floor(n))) : 0;
    } catch (e) {
      this._debugLevel = 0;
    }
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
   * Internal helper to emit logs with unified JSON/text formatting.
   * @private
   * @param {number} threshold - minimum debug level required to emit
   * @param {string} consoleMethod - name of console method to call (error, warn, info, log, debug)
   * @param {string} levelLabel - textual level label for JSON mode
   * @param {any[]} args - original arguments array
   */
  _emit(threshold, consoleMethod, levelLabel, args, opts = {}) {
    if (!this.isDebugLevel(threshold)) return;
    const resolved = args.map((a) => (typeof a === 'function' ? a() : a));

    // Build a structured payload that output() handlers can use.
    const msg = opts.msgArray ? resolved : resolved.length === 1 ? resolved[0] : resolved;
    let payload = { level: levelLabel, msg, ts: Date.now() };
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
              } catch (e) {}
              return;
            }
            // No output transport: write string directly to console.
            if (console && typeof console[consoleMethod] === 'function') {
              console[consoleMethod](formatted);
            }
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
    if (!console || typeof console[consoleMethod] !== 'function') return;
    if (this._format === 'json') {
      try {
        const out = typeof payload === 'string' ? payload : JSON.stringify(payload);
        console[consoleMethod](out);
      } catch (e) {
        // fallback: attempt plain console with resolved args
        console[consoleMethod](...(Array.isArray(resolved) ? resolved : [resolved]));
      }
    } else {
      console[consoleMethod](...resolved);
    }
  }

  /**
   * Log an error-level message when debug level is >= 1.
   * Accepts values or functions (lazy evaluated).
   * @param {...any} args
   * @returns {void}
   */
  error(...args) {
    try {
      this._emit(1, 'error', 'error', args);
    } catch (e) {}
  }

  /**
   * Log a warning-level message when debug level is >= 2.
   * @param {...any} args
   * @returns {void}
   */
  warn(...args) {
    try {
      this._emit(2, 'warn', 'warn', args);
    } catch (e) {}
  }

  /**
   * Log an info-level message when debug level is >= 3.
   * @param {...any} args
   * @returns {void}
   */
  info(...args) {
    try {
      this._emit(3, 'info', 'info', args);
    } catch (e) {}
  }

  /**
   * Log a verbose message when debug level is >= 3.
   * @param {...any} args
   * @returns {void}
   */
  log(...args) {
    try {
      this._emit(3, 'log', 'log', args);
    } catch (e) {}
  }

  /**
   * Log using `console.debug` when level >= 3 (alias for verbose debug output).
   * Supports JSON mode similar to other methods.
   */
  debug(...args) {
    try {
      this._emit(3, 'debug', 'debug', args);
    } catch (e) {}
  }

  /**
   * Display tabular data. Uses `console.table` when available.
   * In JSON mode emits `{ level: 'table', msg: args, ts }` where `msg` is an array of arguments.
   */
  table(...args) {
    try {
      if (!this.isDebugLevel(3) || !console) return;
      // For JSON mode reuse the _emit helper but force the message to be an array
      if (this._format === 'json') {
        this._emit(3, 'log', 'table', args, { msgArray: true });
        return;
      }
      const resolved = args.map((a) => (typeof a === 'function' ? a() : a));
      if (typeof console.table === 'function') console.table(...resolved);
      else if (typeof console.log === 'function') console.log(...resolved);
    } catch (e) {}
  }

  /**
   * Increment an internal named counter (no-op when debug is disabled).
   * Useful for lightweight instrumentation in tests.
   * @param {string} name
   * @returns {void}
   */
  incrementCounter(name) {
    try {
      if (!this.isDebug()) return;
      const k = String(name || '');
      if (!k) return;
      this._counters[k] = (this._counters[k] || 0) + 1;
    } catch (e) {}
  }

  /**
   * Read counters as a plain object snapshot.
   * @returns {Record<string,number>}
   */
  getDebugCounters() {
    try {
      return Object.assign({}, this._counters);
    } catch (e) {
      return {};
    }
  }

  /**
   * Reset all internal counters (test helper).
   * @returns {void}
   */
  resetDebugCounters() {
    try {
      this._counters = Object.create(null);
    } catch (e) {}
  }
}
