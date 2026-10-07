# PowerDeadline

Deadline-aware async helper for timeouts, retry budgets, and cancellation metadata.

Use `PowerDeadline` when you want to wrap a promise-producing operation with:

- an optional per-attempt timeout
- an overall deadline for the entire operation
- retry/backoff behavior and retry policy
- AbortSignal cancellation metadata

## Usage

`PowerDeadline` exposes both a static convenience API and an instance-based API:

```javascript
import { PowerDeadline } from '../src/helpers/powerDeadline.js';

const result = await PowerDeadline.run(
  async () => {
    const response = await fetch('/api/data');
    return response.json();
  },
  {
    maxAttempts: 3,
    attemptTimeout: 2000,
    totalTimeout: 7000,
    retryDelay: 100,
    retryIf: (err) => err.code !== 'EABORT',
  }
);
```

Or create a configured instance and reuse options:

```javascript
const deadline = new PowerDeadline({
  maxAttempts: 2,
  attemptTimeout: 1500,
  retryDelay: 50,
});

const data = await deadline.run(() => fetch('/api/data').then((r) => r.json()));
```

## Options

| Option           |          Type |      Default | Description                                                                                                            |
| ---------------- | ------------: | -----------: | ---------------------------------------------------------------------------------------------------------------------- |
| `maxAttempts`    |      `number` |          `1` | Maximum attempts, including the initial try.                                                                           |
| `attemptTimeout` |      `number` |  `undefined` | Per-attempt timeout in milliseconds. If exceeded, the attempt rejects with `code === 'ETIMEOUT'`.                      |
| `totalTimeout`   |      `number` |  `undefined` | Overall deadline in milliseconds for the complete operation. If exceeded, the run rejects with `code === 'EDEADLINE'`. |
| `retryDelay`     |      `number` |          `0` | Delay in milliseconds before retrying after a failed attempt.                                                          |
| `retryIf`        |    `Function` | `() => true` | Predicate `(err) => boolean` to determine whether a failed attempt should be retried.                                  |
| `signal`         | `AbortSignal` |  `undefined` | Optional signal that cancels the run with `code === 'EABORT'`.                                                         |
| `onRetry`        |    `Function` |  `undefined` | Callback `(attempt, err, delay) => void` invoked before waiting the retry delay.                                       |

## API

- `PowerDeadline.run(fn, options?)` — Run `fn` under the provided deadline options.
- `new PowerDeadline(options)` — Create a configured helper instance.
- `deadline.run(fn, options?)` — Run a function with the instance defaults merged with per-call overrides.

## Example

```javascript
import { PowerDeadline } from '../src/helpers/powerDeadline.js';

const controller = new AbortController();
const deadline = new PowerDeadline({
  maxAttempts: 3,
  attemptTimeout: 2500,
  totalTimeout: 10000,
  retryDelay: 200,
  retryIf: (err) => err && err.code !== 'EABORT',
});

setTimeout(() => controller.abort(), 5000);

try {
  const payload = await deadline.run(
    async () => {
      const res = await fetch('/api/events');
      if (!res.ok) throw new Error('fetch failed');
      return res.json();
    },
    { signal: controller.signal }
  );
  console.log('payload', payload);
} catch (err) {
  console.error('deadline failed', err.code, err.attempts, err.elapsedMs);
}
```

## Notes

- `attemptTimeout` applies to each individual invocation of `fn`.
- `totalTimeout` governs the entire operation, including retries and retry delays.
- If `retryIf` returns `false`, the helper rejects immediately without retrying.
- Aborted runs reject with `code === 'EABORT'` and include the signal reason if provided.
- **An already-aborted signal rejects without calling `fn` at all.** If you pass a
  signal that has already been cancelled, no attempt is made and no side effect
  happens. This is not the same as aborting mid-flight, and it used to be:
  `fn` was invoked once, its side effects happened, and its result was then
  discarded in favour of the same `EABORT` rejection.
- **Your `fn` receives one combined signal, and it is released when the attempt
  ends.** `PowerDeadline` joins your `signal` with the per-attempt timeout signal
  (and with the internal deadline controller) so a single `signal` parameter
  covers all three. The combination is **detached in the attempt's `finally`**,
  so a long-lived signal — a request-scoped one, passed to every operation in the
  request — does not accumulate a listener per attempt. Before 2.0 it did: each
  attempt added an `abort` listener on the shared signal, and `{ once: true }` only
  avoids a _second_ invocation after an event that, on a successful run, never
  fires. The consequence of detaching is that the combined signal **stops
  observing aborts once the attempt has settled** — it is scoped to that attempt,
  not to the run.
- A timed-out attempt is a **failed attempt**, not a terminal error, so it is retried
  like any other. `maxAttempts: 3` with `attemptTimeout: 2000` means "up to 3 attempts,
  each bounded at 2s" — not "2s in total, tried once".
- `backoff`, `baseDelay`, `maxDelay`, `jitter`, `attemptTimeout` and `retryIf` are
  forwarded to [`PowerRetry`](powerRetry.md), which owns the retry policy. `PowerDeadline`
  adds the total budget and the external abort on top. `PowerRetry`'s `budget` and
  `hedgeDelay` are **not** forwarded: a retry budget is a per-client, cross-traffic
  concern that should be constructed once and passed to `PowerRetry` directly.
