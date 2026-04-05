# PowerRetry

Retry helper with configurable backoff and jitter. Use to wrap flaky async operations such as HTTP requests.

## Function

`PowerRetry(fn, options?)`

## Options

| Option | Type | Default | Description |
|---|---:|---:---|---|
| `maxAttempts` | `number` | `3` | Maximum attempts (initial try + retries). |
| `backoff \| exponential \| linear \| fixed` | `'exponential'` | Backoff strategy. |
| `baseDelay` | `number` (ms) | `100` | Base delay used to compute backoff. |
| `maxDelay` | `number` (ms) | `10000` | Maximum delay between retries. |
| `jitter` | `boolean` | `true` | Add random jitter to delays to avoid thundering herd. |
| `retryIf` | `Function` | `() => true` | Predicate `(err) => boolean` to decide whether to retry on a given error. |
| `onRetry` | `Function` | `undefined` | Optional callback `(attempt, err, delay) => void` invoked before waiting the delay. |

## Example

```javascript
import { PowerRetry } from '../src/helpers/powerRetry.js';

async function fetchJson(url) {
  return PowerRetry(
    () => fetch(url).then((r) => {
      if (!r.ok) throw Object.assign(new Error('HTTP'), { status: r.status });
      return r.json();
    }),
    {
      maxAttempts: 4,
      backoff: 'exponential',
      baseDelay: 200,
      jitter: true,
      retryIf: (err) => err && err.status >= 500,
    }
  );
}
```
