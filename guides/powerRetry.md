# PowerRetry

Retry helper with configurable backoff and jitter. Use to wrap flaky async operations such as HTTP requests.

## Usage

Class API: construct with default options and call `run()` per attempt.

`const retryer = new PowerRetry(options?)`

`await retryer.run(fn, options?)`

Or use the static convenience: `await PowerRetry.run(fn, options?)`.

## Options

| Option | Type | Default | Description |
|---|---:|---:|---|
| `maxAttempts` | `number` | `3` | Maximum attempts (initial try + retries). |
| `backoff \| exponential \| linear \| fixed` | `'exponential'` | Backoff strategy. |
| `baseDelay` | `number` (ms) | `100` | Base delay used to compute backoff. |
| `maxDelay` | `number` (ms) | `10000` | Maximum delay between retries. |
| `jitter` | `boolean` | `true` | Add random jitter to delays to avoid thundering herd. |
| `retryIf` | `Function` | `() => true` | Predicate `(err) => boolean` to decide whether to retry on a given error. |
| `onRetry` | `Function` | `undefined` | Optional callback `(attempt, err, delay) => void` invoked before waiting the delay. |
| `attemptTimeout` | `number` (ms) | `undefined` | Per-attempt timeout in milliseconds; if an attempt exceeds this time it will be rejected and counted as a failed attempt. |

## Example

```javascript
import { PowerRetry } from '../src/helpers/powerRetry.js';

// Instance-based usage (preferred when reusing options)
const retryer = new PowerRetry({
  maxAttempts: 4,
  backoff: 'exponential',
  baseDelay: 200,
  jitter: true,
  attemptTimeout: 3000,
  retryIf: (err) => err && err.status >= 500,
});

async function fetchJson(url) {
  return retryer.run(() =>
    fetch(url).then((r) => {
      if (!r.ok) throw Object.assign(new Error('HTTP'), { status: r.status });
      return r.json();
    })
  );
}

// Or call the static helper directly for one-off calls
// (one-off usage shown above; call the static helper for simple calls)
```
