# Now utilities

This guide documents the small timing helpers exported by the library (`nowMs`, `monoMs`, `measureSync`, `measureAsync`) and best practices for measuring short-lived work in Node and browsers.

## Overview

- `nowMs()` — high-resolution timestamp in milliseconds, mapped to epoch time, with a fractional part when the platform provides one. Cross-checks against `Date.now()`, so a test harness that fakes the wall clock can drive it.
- `monoMs()` — the same value from the same sources, but **without** the wall-clock cross-check, so it never moves when the system clock is adjusted. One clock read instead of two.
- `measureSync(fn)` — runs a synchronous function `fn()` and returns `{ result, ms }` where `ms` is the elapsed time in milliseconds.
- `measureAsync(fn)` — runs an async function (or a function that returns a Promise) and returns a Promise resolving to `{ result, ms }`. On rejection the thrown error is augmented with a `durationMs` property indicating how long the call ran.

## Which one to use

The choice is not stylistic — it is the difference between a clock that can jump and one that cannot.

| You want                          | Use        | Because                                                                                 |
| --------------------------------- | ---------- | --------------------------------------------------------------------------------------- |
| An **instant** a caller will read | `nowMs()`  | It tracks the wall clock, so `Date`, a log line or an HTTP `Retry-After` agree with it. |
| A **duration** (b - a)            | `monoMs()` | An NTP adjustment cannot become elapsed time. Also one clock read instead of two.       |

`PowerCron.nextRunAt` uses `nowMs()`, because it is documented as epoch
milliseconds. `PowerGCRA`, `PowerThrottle`, `PowerSlidingWindow` and
`PowerCircuit` use `monoMs()`, because all four only ever _subtract_.

Both are still epoch timestamps: `monoMs()` anchors the monotonic source to an
epoch offset captured once at module load, so the value is comparable with a
wall clock. What it is not is _adjustable_ — it tracks real elapsed time, and
only real elapsed time.

### What a wall-clock adjustment used to do

Measured before the change, with **zero** real milliseconds elapsed and only the
wall clock moved forward:

| Helper                                       | Before                              | Now              |
| -------------------------------------------- | ----------------------------------- | ---------------- |
| `PowerGCRA({rate:10, per:1000, burst:1})`    | `available()` 0 -> 2, burst granted | stays 0, refused |
| `PowerCircuit({threshold:1, timeout:60000})` | `open` -> `half-open`               | stays `open`     |

`nowMs()` reads the high-resolution source **and** `Date.now()`, and returns the
latter once the two diverge by more than a second. So after an NTP step the
helpers silently switched to the wall clock, and the step counted as elapsed
time. A rate limiter that refills to capacity because the clock jumped has
stopped bounding load.

The step that matters is the **forward** one. A backward step was always
harmless to these helpers — `PowerGCRA` clamps with `Math.max(now, _tat)` — so
if you were told the danger was a clock going backwards, that was wrong.

## Usage

Synchronous timing:

```js
import { nowMs, measureSync } from '../src/utils/now.js';

const { result, ms } = measureSync(() => {
  // work you want to measure
  return doWorkSync();
});
console.log('sync duration (ms):', ms);
```

Elapsed time across a wall-clock adjustment, which is the reason `monoMs()` exists:

```js
import { monoMs } from '../src/utils/now.js';

// Correct even if the system clock is stepped by NTP in the middle.
const startedAt = monoMs();
await doWork();
const elapsed = monoMs() - startedAt;
```

Asynchronous timing (recommended for I/O or worker operations):

```js
import { measureAsync } from '../src/utils/now.js';

const { result, ms } = await measureAsync(async () => {
  return await doWorkAsync();
});
console.log('async duration (ms):', ms);
```

When an async measure rejects, `measureAsync` rethrows the original error but attaches a numeric `durationMs` property (ms) to the error object so callers can reason about partial progress in failure scenarios.

## Notes and best practices

- Both clocks use the highest-resolution source available on the runtime (`performance.timeOrigin + performance.now()`, or `process.hrtime.bigint()` on Node) and return a floating-point milliseconds value for convenience and to match the rest of the library.
- **Testing a limiter's clock: inject it.** The rate limiters take a `now` constructor option that always wins over the built-in clock, so faking `Date.now()` is neither necessary nor sufficient — after the change above, `monoMs()` ignores the wall clock entirely. `PowerCircuit` has no `now` option.
- Under fake timers, `vi.advanceTimersByTime(...)` moves the monotonic clock and `vi.setSystemTime(...)` moves `Date.now()` alone.
- For benchmarking tiny code paths (sub-microsecond) consider repeating the call many times and measuring aggregate duration to avoid timer quantization noise.
- Avoid instrumenting extremely hot loops with per-iteration timing unless you aggregate the results — the overhead of calling `nowMs()` may affect throughput.

## Example: measure and attach to errors

```js
import { measureAsync } from '../src/utils/now.js';

try {
  await measureAsync(async () => {
    await flakyNetworkCall();
  });
} catch (err) {
  console.error('failed after', err.durationMs, 'ms');
}
```
