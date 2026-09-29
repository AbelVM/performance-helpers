/**
 * Drain the microtask queue, for awaiting work that is already resolved.
 *
 * TEST-008. The idiom this replaces is `await new Promise((r) => setTimeout(r, 0))`
 * — or worse, `10` or `30` — used to let a chain of already-settled promises
 * finish. A `setTimeout(0)` is a **macrotask**: it drains every pending
 * microtask *and* a full turn of the event loop, so its cost scales with how
 * busy the loop is. On a loaded machine that is not a slow test, it is a
 * flaky one.
 *
 * **Use it only where the code being awaited is promise-based and timer-free.**
 * A real timer, a `PowerScheduler` flush, or an unhandled-rejection check needs
 * genuine event-loop turns and `setSafeTimeout`-based code will not have run.
 * Examples in this repository that must keep real waits, all recorded rather
 * than silently converted — including two converted during this work, whose
 * failures are the reason this list exists:
 *
 *   - `test/powerEventLoopMonitor.test.js` — measures the *actual* delay of the
 *     event loop, so a faked clock would assert against a fabrication.
 *   - `test/powerBackpressure.aimd.test.js` — depends on real scheduling
 *     interleaving between a producer loop and the controller; the fake clock
 *     starves the AIMD additive-growth signal.
 *   - the `unhandledRejection` cases in `test/cache.bugs.test.js` — a rejection
 *     surfaces at an event-loop turn, not at a microtask.
 *
 * Two hops by default, because the common chain is factory -> dedupe entry ->
 * `finally` and a single hop lands in the middle of it.
 *
 * @param {number} [hops=2] - Microtask hops to yield. Raise it for a longer
 *   chain rather than reaching for a timer.
 * @returns {Promise<void>}
 */
export async function flush(hops = 2) {
  for (let i = 0; i < hops; i += 1) await Promise.resolve();
}

export default flush;
