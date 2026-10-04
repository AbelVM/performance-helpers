// High-resolution now in milliseconds, mapped to epoch time.
// Use performance.timeOrigin+performance.now() when available, or derive an
// epoch offset for hrtime to keep timestamps comparable with Date.now().
let _hrtimeEpochOffset = null;
if (
  typeof process !== 'undefined' &&
  process?.hrtime &&
  typeof process.hrtime.bigint === 'function'
) {
  try {
    const hr = Number(process.hrtime.bigint() / 1000000n);
    _hrtimeEpochOffset = Date.now() - hr;
  } catch (e) {
    _hrtimeEpochOffset = null;
  }
}

// Decide whether to use high-resolution performance/hrt-based time or
// fallback to Date.now(). Under test harnesses that fake timers,
// `Date.now()` may be advanced by the fake timer while `performance.now()`
// or `process.hrtime()` remain tied to real time. To keep tests reliable
// prefer performance/hrt only when it's close to Date.now() (small delta).
/**
 * The high-resolution clock, resolved once.
 *
 * `() => performance.timeOrigin + performance.now()`, or `null` where
 * `performance` is absent or does not carry a `timeOrigin`. Resolved at module
 * load rather than per call - see the note inside `nowMs`.
 *
 * @type {(() => number)|null}
 */
const _perfNow =
  typeof performance !== 'undefined' &&
  typeof performance?.now === 'function' &&
  typeof performance?.timeOrigin === 'number'
    ? () => performance.timeOrigin + performance.now()
    : null;

/**
 * One clock-reading body, shared by {@link nowMs} and {@link monoMs}.
 *
 * The two differ in exactly one thing - whether a wall-clock reading is
 * supplied to cross-check the high-resolution source against - and they were
 * two near-identical functions until RES-019, which is the shape this project
 * has been bitten by repeatedly (POOL-004 and CACHE-004 are the same lesson in
 * other files). So the selection ladder is written once and the *policy* is the
 * argument.
 *
 * `wallDateNow` is `Date.now()` for {@link nowMs} and `undefined` for
 * {@link monoMs}. `undefined` means "this source is trusted on its own", and it
 * is a real distinction rather than a style choice: with no wall reading to
 * compare against, the closeness check cannot run, so the high-resolution
 * source is returned unconditionally. Both sources it can reach -
 * `performance.now()` and `process.hrtime.bigint()` - are monotonic *by
 * specification*, so unconditional is correct. See `monoMs` for why the check
 * exists at all and what it costs.
 *
 * @param {number|undefined} wallDateNow - `Date.now()`, or `undefined` to
 *   return the high-resolution source without cross-checking it.
 * @returns {number} Milliseconds since epoch (floating point).
 * @private
 */
function _clockReading(wallDateNow) {
  // The capability checks are loop-invariant and were being re-evaluated on
  // every single call. Resolving the high-resolution source once at module load
  // is worth more than threading a single `now` through every limiter (which is
  // what PERF-007 proposed): this is on the hot path of essentially
  // every helper in the library, and measured **141 ns** per call - against a
  // `PowerThrottle.tryConsume` of **164 ns** in total. The `typeof` guards, the
  // optional-chain property reads and the `try`/`catch` frame were most of it.
  //
  // The bound source can still throw or go stale (a test harness replacing
  // `globalThis.performance`, a torn-down sandbox), so the `try` and the
  // closeness check stay: only the *resolution* moved out of the hot path.
  if (_perfNow) {
    try {
      const perfVal = _perfNow();
      // If perf-based time is close to Date.now(), prefer it for higher resolution.
      if (wallDateNow === undefined || Math.abs(perfVal - wallDateNow) < 1000) return perfVal;
      return wallDateNow;
    } catch (e) {
      // fall through to other methods
    }
  }

  if (_hrtimeEpochOffset != null) {
    try {
      const hrVal = Number(process.hrtime.bigint() / 1000000n) + _hrtimeEpochOffset;
      if (wallDateNow === undefined || Math.abs(hrVal - wallDateNow) < 1000) return hrVal;
      return wallDateNow;
    } catch (e) {
      return wallDateNow === undefined ? Date.now() : wallDateNow;
    }
  }

  return wallDateNow === undefined ? Date.now() : wallDateNow;
}

/**
 * Get a high-resolution timestamp in milliseconds since the epoch.
 *
 * This function prefers `performance.timeOrigin + performance.now()` when
 * available and reasonably close to `Date.now()` to provide higher resolution
 * timestamps. On Node.js it uses `process.hrtime.bigint()` with an epoch offset
 * when available. Falls back to `Date.now()` if nothing
 * better is available or when offsets appear to diverge (e.g. in some
 * test harnesses).
 *
 * **The wall-clock cross-check is what makes this clock movable, and that is
 * sometimes required.** It is what lets a test harness that fakes `Date.now()`
 * drive a helper's notion of time, and it is why `PowerCron.nextRunAt` can be
 * documented as epoch milliseconds. The price is that a helper which only ever
 * *subtracts* inherits the wall clock's ability to jump - see
 * {@link monoMs} for the measurement and for the four helpers that use it
 * instead.
 *
 * @returns {number} Milliseconds since epoch (floating point for higher resolution).
 */
export const nowMs = () => _clockReading(Date.now());

/**
 * A **monotonic** high-resolution timestamp in milliseconds since the epoch.
 *
 * Same ladder, same sources, same epoch mapping as {@link nowMs} - and one
 * difference: `Date.now()` is never read, so the value cannot be moved by a
 * wall-clock adjustment. The epoch offset is captured once at module load, so
 * the result is a real epoch timestamp that only ever increases.
 *
 * Use it for **delta arithmetic**, where only the difference between two
 * readings is ever used: rate limiters, circuit-breaker windows, token-bucket
 * refill. Use {@link nowMs} for anything a caller will read as an instant -
 * `PowerCron.nextRunAt`, a log line, an HTTP `Retry-After`.
 *
 * **Why, measured.** `nowMs()` is two clock reads, and the second exists only to detect
 * a divergence. Within a second of wall time the guard passes and the value
 * tracks `performance`, so the limiter's elapsed-time arithmetic is sound -
 * but a clock adjusted by more than a second fails the guard, and from that
 * moment the helper silently reads `Date.now()`. Two measurements of the
 * consequence, both with **zero** real milliseconds elapsed:
 *
 * - `PowerGCRA({rate: 10, per: 1000, burst: 1})` saturated at `available() ===
 *   0` reported `available() === 2` and admitted after the wall clock stepped
 *   forward 5 s. `2` is `_ceiling()`, so that is the whole burst, granted.
 * - `PowerCircuit({threshold: 1, timeout: 60000})` reported `half-open` after a
 *   60 s forward step, so a dependency that had been failing for 1 ms was
 *   offered a trial call.
 *
 * Both are **forward** steps, which is worth stating because the obvious
 * reading is backwards: a backward step is harmless to these helpers, because
 * `PowerGCRA`'s `Math.max(now, _tat)` clamp and `PowerCircuit`'s `nowMs() -
 * _openedAt < _openWindowMs` comparison both keep interpreting an earlier
 * reading as "not much time has passed". It is the jump forward that hands out
 * budget nobody spent.
 *
 * **The cost, stated rather than hidden.** A consumer who fakes `Date.now()` to
 * drive a limiter's clock will stop doing so - the four helpers using this
 * clock ignore it. The supported injection point is a limiter's `now` option,
 * which has always been authoritative (`resolveLimiterNow` gives it precedence
 * over everything, including a per-call value). `PowerCircuit` has no `now`
 * option, so for that class a faked `Date.now()` was never a documented way in
 * and is not one now.
 *
 * **The guarantee is by source, not by clamping.** Both sources this can reach -
 * `performance.now()` and `process.hrtime.bigint()` - are monotonic by
 * specification, and the epoch offsets (`performance.timeOrigin`,
 * `_hrtimeEpochOffset`) are fixed for the module's lifetime. A last-value floor
 * was considered and rejected: it would prevent the value going *backwards*
 * while still permitting the forward jumps that are the actual defect, so it
 * would cost a branch on the hot path and a module-level mutable to fix the
 * wrong direction. The `Date.now()` fallback is reached only on a platform
 * offering neither high-resolution clock, where nothing monotonic exists to use.
 *
 * @returns {number} Milliseconds since epoch (floating point), non-decreasing.
 */
export const monoMs = () => _clockReading(undefined);

export default nowMs;

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
export function measureSync(fn) {
  const start = nowMs();
  try {
    const result = typeof fn === 'function' ? fn() : fn;
    const end = nowMs();
    return { result, ms: end - start, start, end };
  } catch (e) {
    const end = nowMs();
    // Attach duration to the thrown error for caller diagnostics.
    //
    // The binding of a `catch` clause is `unknown`, and the thrown value really
    // can be a primitive or a frozen object, so the annotation is written as a
    // runtime check rather than a cast. Strict mode makes `prim.durationMs = x`
    // throw, which the previous unconditional assignment relied on its own
    // `try`/`catch` to swallow - same outcome, without pretending the value is
    // known to be an object.
    try {
      if (e !== null && typeof e === 'object') Reflect.set(e, 'durationMs', end - start);
    } catch (_) {
      // `e` may be a frozen object or an exotic proxy; the duration annotation
      // is a diagnostic nicety, not the caller's result.
    }
    throw e;
  }
}

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
 * @param {Function|Promise<any>|any} fn - Async function, Promise, or direct value.
 * @returns {Promise<{result:any, ms:number, start:number, end:number}>} Promise resolving to result and timing.
 * @throws {*} Re-throws any rejection from `fn` after attaching `durationMs`.
 */
export async function measureAsync(fn) {
  const start = nowMs();
  try {
    const value = typeof fn === 'function' ? fn() : fn;
    const result = await value;
    const end = nowMs();
    return { result, ms: end - start, start, end };
  } catch (e) {
    const end = nowMs();
    // See the note in `measureSync`: the `catch` binding is `unknown` and the
    // thrown value may be a primitive, so the annotation is a runtime check.
    try {
      if (e !== null && typeof e === 'object') Reflect.set(e, 'durationMs', end - start);
    } catch (_) {
      // `e` may be a frozen object or an exotic proxy; the duration annotation
      // is a diagnostic nicety, not the caller's result.
    }
    throw e;
  }
}
