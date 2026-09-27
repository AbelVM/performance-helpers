// Timer helpers that never keep a Node.js process alive on their own.
//
// Every long-lived helper in this library schedules background work
// (cache eviction sweeps, pool idle reapers, backpressure refills, retry
// timeouts, ...). In Node.js a bare `setTimeout`/`setInterval` returns a
// `Timeout` whose `ref()` keeps the event loop alive, so a forgotten
// `PowerCache` with cleanup enabled - or a `PowerPool` whose reaper interval
// was cleared but whose workers were resurrected - would hang a CLI or a
// serverless handler forever.
//
// The helpers below unref the returned handle on Node (a no-op elsewhere, and
// on Node < 0.9 semantics it degrades to the normal timer). Callers that
// explicitly want the handle held - a CLI awaiting a background flush, for
// example - pass `keepProcessAlive: true`.

/**
 * @typedef {object} TimerOptions
 * @property {boolean} [keepProcessAlive=false] - When `true`, skip the
 *   `unref()` call so the timer keeps the Node.js event loop alive.
 */

/**
 * Detect whether the current runtime exposes ref-able Node.js timer handles.
 * @returns {boolean} `true` when `setTimeout` returns an object with `unref`.
 * @private
 */
function _canUnref() {
  return typeof setTimeout === 'function' && typeof setTimeout(() => {}, 0)?.unref === 'function';
}

/**
 * Schedule a one-shot timer that does not keep the Node.js process alive.
 *
 * @param {Function} fn - Callback invoked after the delay.
 * @param {number} ms - Delay in milliseconds.
 * @param {TimerOptions} [options] - Timer options.
 * @returns {any} The underlying timer handle (`Timeout` in Node.js, a number
 *   in browsers). Usable with `clearTimeout`.
 */
export function setSafeTimeout(fn, ms, options = {}) {
  const t = setTimeout(fn, ms);
  if (!options.keepProcessAlive && _canUnref()) t.unref();
  return t;
}

/**
 * Schedule a repeating timer that does not keep the Node.js process alive.
 *
 * @param {Function} fn - Callback invoked on every tick.
 * @param {number} ms - Period in milliseconds.
 * @param {TimerOptions} [options] - Timer options.
 * @returns {any} The underlying timer handle. Usable with `clearInterval`.
 */
export function setSafeInterval(fn, ms, options = {}) {
  const t = setInterval(fn, ms);
  if (!options.keepProcessAlive && _canUnref()) t.unref();
  return t;
}

export default setSafeTimeout;
