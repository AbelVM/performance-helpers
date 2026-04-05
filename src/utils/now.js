// High-resolution now in milliseconds, mapped to epoch time.
// Use performance.timeOrigin+performance.now() when available, or derive an
// epoch offset for hrtime to keep timestamps comparable with Date.now().
let _hrtimeEpochOffset = null;
if (
  typeof process !== 'undefined' &&
  process.hrtime &&
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
 * Get a high-resolution timestamp in milliseconds since the epoch.
 *
 * This function prefers `performance.timeOrigin + performance.now()` when
 * available and reasonably close to `Date.now()` to provide higher
 * resolution timestamps. On Node.js it uses `process.hrtime.bigint()` with
 * an epoch offset when available. Falls back to `Date.now()` if nothing
 * better is available or when offsets appear to diverge (e.g. in some
 * test harnesses).
 *
 * @returns {number} Milliseconds since epoch (floating point for higher resolution).
 */
export const nowMs = () => {
  const dateNow = Date.now();

  if (
    typeof performance !== 'undefined' &&
    typeof performance.now === 'function' &&
    typeof performance.timeOrigin === 'number'
  ) {
    try {
      const perfVal = performance.timeOrigin + performance.now();
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
