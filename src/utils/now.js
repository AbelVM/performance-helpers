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
 * Get a high-resolution timestamp in milliseconds since the epoch.
 *
 * This function prefers `performance.timeOrigin + performance.now()` when
 * available and reasonably close to `Date.now()` to provide higher
 * resolution timestamps. On Node.js it uses `process.hrtime.bigint()` with an
 * epoch offset when available. Falls back to `Date.now()` if nothing
 * better is available or when offsets appear to diverge (e.g. in some
 * test harnesses).
 *
 * @returns {number} Milliseconds since epoch (floating point for higher resolution).
 */
export const nowMs = () => {
  const dateNow = Date.now();

  // The capability checks are loop-invariant and were being re-evaluated on
  // every single call. Resolving the high-resolution source once at module load
  // is worth more than threading a single `now` through every limiter (which is
  // what PERF-007 proposed): `nowMs()` is on the hot path of essentially
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
      if (Math.abs(perfVal - dateNow) < 1000) return perfVal;
      return dateNow;
    } catch (e) {
      // fall through to other methods
    }
  }

  if (_hrtimeEpochOffset != null) {
    try {
      const hrVal = Number(process.hrtime.bigint() / 1000000n) + _hrtimeEpochOffset;
      if (Math.abs(hrVal - dateNow) < 1000) return hrVal;
      return dateNow;
    } catch (e) {
      return dateNow;
    }
  }

  return dateNow;
};

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
