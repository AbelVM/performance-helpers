# PowerRetry

Retry helper with configurable backoff, jitter, a retry budget, and optional
hedged attempts. Use to wrap flaky async operations such as HTTP requests.

`PowerRetry` answers three separate questions, and it is worth keeping them
apart:

1. **How long to wait between attempts?** — `backoff` and `jitter`.
2. **Whether to retry at all?** — `budget`.
3. **Whether to attack the tail?** — `hedgeDelay`.

Most callers only ever need the first. The other two exist because the first
one alone does not prevent the two failure modes that actually hurt in
production: a retry storm that amplifies load on a dependency that is already
failing, and a p99 that is orders of magnitude above your p50.

## Usage

Class API: construct with default options and call `run()` per attempt.

`const retryer = new PowerRetry(options?)`

`await retryer.run(fn, options?)`

Or use the static convenience: `await PowerRetry.run(fn, options?)`.

## Options

| Option           |                                                     Type |         Default | Description                                                                                                                                            |
| ---------------- | -------------------------------------------------------: | --------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxAttempts`    |                                                 `number` |             `3` | Maximum attempts (initial try + retries). Must be `>= 1`.                                                                                              |
| `backoff`        | `'exponential' \| 'linear' \| 'fixed' \| 'decorrelated'` | `'exponential'` | Backoff strategy. An unrecognised value throws.                                                                                                        |
| `baseDelay`      |                                            `number` (ms) |           `100` | Base delay used to compute backoff.                                                                                                                    |
| `maxDelay`       |                                            `number` (ms) |         `10000` | Maximum delay between retries.                                                                                                                         |
| `jitter`         |                                                `boolean` |          `true` | Randomise the delay within `[0.5 * delay, delay]`. Rejected when `backoff` is `decorrelated`.                                                          |
| `retryIf`        |                                    `Function \| boolean` |    `() => true` | Predicate `(err) => boolean` to decide whether to retry on a given error. A non-function is read as a fixed policy. **A throw is treated as `false`.** |
| `onRetry`        |                                               `Function` |     `undefined` | Callback `(attempt, err, delay) => void` invoked before waiting the delay. Throwing here does not change the outcome.                                  |
| `attemptTimeout` |                                            `number` (ms) |     `undefined` | Per-attempt timeout. An attempt that exceeds it is rejected and **counted as a failed attempt**, so it is retried like any other.                      |
| `budget`         |      `PowerRetryBudget \| { ratio, capacity } \| number` |     `undefined` | Retry budget. See [Retry budget](#retry-budget).                                                                                                       |
| `hedgeDelay`     |                                            `number` (ms) |             `0` | Send a duplicate of the **first** attempt if it has not returned in this long. `0` disables hedging. See [Hedging](#hedging).                          |

## Example

```javascript
import { PowerRetry, PowerRetryBudget } from '../src/helpers/powerRetry.js';

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
const config = await PowerRetry.run(() => fetch('/api/config').then((r) => r.json()));
```

### A throwing `retryIf` declines

`retryIf` is your code, called from inside the retry loop's `catch` block. **A
throw from it is caught and treated as `false`** — the run stops and you receive
the error your operation actually failed with.

Two things follow from that, and both are deliberate:

- **You never receive the predicate's own error.** Without the guard, a throw
  escaped the `catch` entirely and became the rejection, so `PowerRetry.run`
  rejected with `"retryIf exploded"` instead of `"the real failure"` — the real
  failure replaced by an error from a function that was only meant to advise
  about it. `onRetry` was already guarded for the same reason; the two are now
  symmetric.
- **Declining is the conservative reading.** `retryIf` answers "is it safe to run
  this again?", and a predicate that cannot be evaluated has not said yes — so
  the fix does not repeat a possibly non-idempotent operation on your behalf.

If you want a thrown predicate to be visible rather than absorbed, log it inside
the predicate, or use `onRetry`, which is called for every attempt that is
actually about to be retried and whose throws are ignored in the same way.

## Backoff

### `exponential` (default)

`delay = baseDelay * 2 ** (attempt - 1)`, capped at `maxDelay`, then jittered
into `[0.5 * delay, delay]`.

### `linear` and `fixed`

`delay = baseDelay * attempt` and `delay = baseDelay` respectively. Useful when
a dependency's recovery time is known rather than guessed.

### `decorrelated`

From AWS, _Exponential Backoff and Jitter_ (2015). Instead of recomputing a
formula per attempt, each delay is drawn against the **previous** delay:

```
sleep = baseDelay
next  = min(maxDelay, random_between(baseDelay, sleep * 3))
```

The difference is not cosmetic. `2 ** attempt * random()` recomputes the same
curve every time, so a fleet of clients that failed at the same instant draws
from the same range at the same instants and keeps re-synchronising. Drawing
against the previous _actual_ delay makes each client's path independent, which
is what the paper is about.

It is a random walk, so `jitter: false` is rejected rather than silently
ignored — the two options contradict each other and one of them would have to
lose.

Because the walk is stateful, `backoff: 'decorrelated'` produces different
sequences on every call. If you need reproducible delays in a test, use
`fixed` with `jitter: false` and assert on the value.

## Retry budget

A budget bounds **retry traffic**, not request traffic. Without one, a
dependency that is failing gets `maxAttempts` times the load of a healthy one,
which is the mechanism behind most retry storms.

A budget is a token bucket with one rule, from the Google SRE Workbook's
_Handling Overload_ chapter: **each request funds the bucket, each retry spends
from it**. During a partial outage the bucket drains, so retries throttle
exactly when the dependency can least afford them.

```javascript
const budget = new PowerRetryBudget({ ratio: 0.2 });

const retryer = new PowerRetry({ maxAttempts: 5, budget });
```

### Why it starts full

A token bucket that started empty would refuse the first retry of a fresh
budget: one request funds `0.2` of a token, and a retry costs a whole one. The
protection would then engage on a _healthy_ dependency and disengage on the
sick one, which is backwards. `capacity` (default 10) is the burst allowance
that covers this.

### Scoping is the part that matters

A budget only does its job if it outlives a single call:

```javascript
// Good - one bucket, shared by every request the client makes.
const budget = new PowerRetryBudget({ ratio: 0.2 });
const retryer = new PowerRetry({ maxAttempts: 5, budget });
await retryer.run(() => callA());
await retryer.run(() => callB());
```

```javascript
// Weak - a bucket is built for this call and dropped with it, so it only caps
// this call's retries at `capacity`.
await PowerRetry.run(() => callA(), { budget: { ratio: 0.2 } });
```

The `PowerRetry` constructor builds the bucket once and reuses it for every
`run()`. The static `PowerRetry.run` builds it per call, which is a coherent
reading but a weak one. Pass a shared `PowerRetryBudget` when you use the
static form.

### Reading a refusal

When the budget refuses a retry, `run()` rejects with the **last error**,
unchanged. The refusal is visible in the budget, not in the error, because
throwing a synthetic "budget exhausted" error would hide the failure that
actually caused the retry.

```javascript
budget.stats();
// { ratio: 0.2, capacity: 10, available: 0, requests: 47, retries: 52, refused: 5 }
```

`refused` growing while `available` sits at 0 is the signature of a dependency
in trouble. Wire it to a log line, or pair the budget with `PowerCircuit`.

## Hedging

A hedge sends a **second copy of the first request** if the first has not
returned within `hedgeDelay`. The first to succeed wins and the loser is
aborted.

```javascript
const data = await PowerRetry.run(() => fetch(url), {
  maxAttempts: 3,
  hedgeDelay: 200, // if the first request is still out at 200ms, send another
});
```

This trades average load for tail latency, and that trade is the whole point:
it cuts p99 by racing two samples of the distribution instead of waiting on
one. It is off by default because it is not free, and because it only helps if
your `fn` honours the `AbortSignal` — otherwise both copies run to completion
and you have doubled the load for nothing.

Points worth knowing:

- **Only the first attempt is hedged.** Hedging every attempt would turn
  `maxAttempts: 3` into 6 requests on the wire, which is the amplification the
  budget exists to prevent.
- **A hedge draws a budget token**, exactly like a retry. A refused budget
  means _no hedge_, not a failed attempt.
- **The loser's signal fires; the winner's does not.** Each request copy gets
  its own `AbortController`.
- **A timed-out attempt is retried**, not short-circuited. `maxAttempts` and
  `attemptTimeout` compose as "3 attempts, each bounded at 3s" — not
  "3s total, once".

## The AbortSignal contract

`fn` receives the attempt's `AbortSignal` when `attemptTimeout` or `hedgeDelay`
is configured, and `undefined` otherwise. Honour it:

```javascript
await PowerRetry.run((signal) => fetch(url, { signal }), {
  attemptTimeout: 3000,
});
```

An attempt that succeeds leaves its signal untouched, so `fn` can finish
cleanly. It is aborted only when the attempt times out, or when it loses a
hedge.

## Validation

Options are validated at call time, and a configuration error throws **before
any request is sent**:

- `backoff` outside the four supported strategies throws. (Before 2.0 the
  implementation was `linear | fixed | else exponential`, so `'exp'` silently
  produced an exponential curve.)
- `jitter: false` with `backoff: 'decorrelated'` throws.
- `maxAttempts` below 1, and non-finite `maxDelay`/`baseDelay`/
  `attemptTimeout`/`hedgeDelay`, throw.
- `budget` that is not a bucket, a `{ ratio, capacity }` object, or a number
  throws.
- `ratio` above 1 throws: a budget permitting more retries than requests is
  the amplification it exists to prevent.

## PowerRetryBudget API

| Member                                      | Description                                                     |
| ------------------------------------------- | --------------------------------------------------------------- |
| `new PowerRetryBudget({ ratio, capacity })` | `ratio` defaults to `0.2`, `capacity` to `10`.                  |
| `recordRequest()`                           | Fund the bucket by one request. Returns the new token count.    |
| `tryConsumeRetry()`                         | Spend one retry token. Returns `false` when empty.              |
| `available()`                               | Current tokens.                                                 |
| `stats()`                                   | `{ ratio, capacity, available, requests, retries, refused }`.   |
| `reset()`                                   | Refill to capacity and zero the counters.                       |
| `dispose()`                                 | Release the metrics registration. Terminal. `reset()` does not, |
|                                             | because a budget can be reset and reused.                       |
| `ratio` / `capacity`                        | The configured values.                                          |

## Cancelling a run

Pass a `signal` and the whole call becomes cancellable, **including the wait
between attempts**:

```javascript
const controller = new AbortController();
const run = PowerRetry.run(fetchFn, { signal: controller.signal });

controller.abort(); // rejects at once, even mid-backoff
```

The backoff wait is the part that matters. Before this, a run could not be
cancelled at all: `attemptTimeout` bounds a slow _attempt_, and nothing bounded a
slow _gap_, so the sleep ran to completion — up to `maxDelay`, which is 30 s at
the default. A promise that settles 30 s after everyone stopped listening is not
a slow success, it is a leaked one.

Rejections carry `code: 'EABORT'` and the signal's `reason`, the same shape
[`PowerDeadline`](powerDeadline.md) uses, so one `err.code` check covers both. An
already-aborted signal rejects **without running an attempt**, and an abort
between attempts stops the next one rather than buying it.

A `signal` given to the constructor is a default for every `run` on that
instance, and is deliberately not stored in the reusable options — an
`AbortSignal` is one-shot, so a stored one would leave the instance holding an
aborted signal after its first use. Once it is aborted, later runs on that
instance reject without doing work, which is the safe direction.

## Composes with

- **`PowerCircuit`** — stops sending at all once the dependency is known-bad.
  A budget and a breaker answer different questions: the budget limits retry
  _volume_, the breaker limits retry _frequency_ when a dependency is
  unhealthy rather than briefly slow.
- **`PowerDeadline`** — adds a total time budget across all attempts, plus
  external abort. Prefer it when the caller's latency SLO matters more than
  the retry policy. `PowerRetry`'s own `signal` is for cancelling _this_ call;
  `PowerDeadline` is for bounding it, and the two compose.
- **`PowerLogger`** — surface `budget.stats()` so a rising `refused` count is
  visible before it becomes an outage.

## See also

- [PowerDeadline](powerDeadline.md) — total budget, external abort, retry under a deadline.
- [PowerCircuit](powerCircuit.md) — stop calling a failing dependency.
- [PowerRateLimit](powerRateLimit.md) — compose limiters to stay inside a contract.
