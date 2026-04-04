// High-resolution now in milliseconds, mapped to epoch time.
// Use performance.timeOrigin+performance.now() when available, or derive an
// epoch offset for hrtime to keep timestamps comparable with Date.now().
let _hrtimeEpochOffset = null;
if (typeof process !== 'undefined' && process.hrtime && typeof process.hrtime.bigint === 'function') {
  try {
    const hr = Number(process.hrtime.bigint() / 1000000n);
    _hrtimeEpochOffset = Date.now() - hr;
  } catch (e) {
    _hrtimeEpochOffset = null;
  }
}

export const nowMs = () => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function' && typeof performance.timeOrigin === 'number') {
    return performance.timeOrigin + performance.now();
  }
  if (_hrtimeEpochOffset != null) {
    try {
      return Number(process.hrtime.bigint() / 1000000n) + _hrtimeEpochOffset;
    } catch (e) {
      return Date.now();
    }
  }
  return Date.now();
};

export default nowMs;
