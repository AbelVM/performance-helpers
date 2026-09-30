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
 * Schedule a one-shot timer that does not keep the Node.js process alive.
 *
 * @param {Function} fn - Callback invoked after the delay.
 * @param {number} ms - Delay in milliseconds.
 * @param {TimerOptions} [options] - Timer options.
 * @returns {any} The underlying timer handle (`Timeout` in Node.js, a number
 *   in browsers). Usable with `clearTimeout`.
 */
export function setSafeTimeout(fn, ms, options = {}) {
  const t = /** @type {any} */ (setTimeout(fn, ms));
  // Probe the handle, not the runtime. This used to call a `_canUnref()`
  // helper that allocated a throwaway `setTimeout` on *every* invocation just
  // to ask whether `unref` existed, and never cleared it - so 200 000 calls
  // produced 400 000 live `Timeout` objects, on the paths that call this in a
  // loop (the event-loop monitor alone made 100 wasted timers a second at a
  // 5 ms sample, in the code whose job is to measure the loop). Asking the
  // handle we were just handed answers the same question with no allocation.
  //
  // It also removes a load-order dependency rather than moving it: a
  // module-level `const` would answer the question once, using whichever
  // `setTimeout` was installed at import time, and apply that answer to every
  // handle afterwards. That is a structural improvement, not a fix for an
  // observed failure - the fake timers this repo's suite installs do return
  // Node-shaped handles, so a cached capability would have worked here too.
  //
  // `setTimeout` resolves to a DOM `number` in a browser type environment and
  // to a Node.js `Timeout` in Node, so the check is on the value rather than
  // asserted through a type that only holds in one of them.
  if (!options.keepProcessAlive && typeof t?.unref === 'function') t.unref();
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
  const t = /** @type {any} */ (setInterval(fn, ms));
  if (!options.keepProcessAlive && typeof t?.unref === 'function') t.unref();
  return t;
}

export default setSafeTimeout;
