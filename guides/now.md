# Now utilities

This guide documents the small timing helpers exported by the library (`nowMs`, `measureSync`, `measureAsync`) and best practices for measuring short-lived work in Node and browsers.

## Overview

- `nowMs()` — high-resolution, monotonic timestamp in milliseconds with fractional part when supported. Prefer this over `Date.now()` for sub-millisecond timing and consistent results across platforms.
- `measureSync(fn)` — runs a synchronous function `fn()` and returns `{ result, ms }` where `ms` is the elapsed time in milliseconds.
- `measureAsync(fn)` — runs an async function (or a function that returns a Promise) and returns a Promise resolving to `{ result, ms }`. On rejection the thrown error is augmented with a `durationMs` property indicating how long the call ran.

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

- `nowMs()` uses the highest-resolution clock available on the runtime (for Node it prefers `process.hrtime.bigint()`), but returns a floating-point milliseconds value for convenience and to match the rest of the library.
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
