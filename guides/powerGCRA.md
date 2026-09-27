# PowerGCRA

Generic Cell Rate Algorithm (GCRA) rate limiter — the cell-based scheduler recommended by the ATM Forum, and the algorithm behind `golang.org/x/time/rate`, Redis's `redis-cell` module and the `redis-gcra` Node port.

`PowerGCRA` shapes traffic the same way a token bucket does, but keeps its entire state in **one number**: the _theoretical arrival time_ (TAT). That makes it O(1) per call with no token accumulator and no floating-point drift.

> **Why not just use `PowerThrottle`?** Both are correct rate limiters. GCRA's practical advantages are (a) an **exact** `retryAfter()` rather than an estimate, so it can be handed straight to a backoff or a `Retry-After` header, and (b) one number of state instead of a bucket, a last-refill timestamp and a remainder accumulator. `PowerThrottle` remains the default elsewhere in this library; GCRA is additive and changes nothing about it.

## How it works

```
tat = max(now, tat) + emissionInterval          on accept
accept  iff  tat <= now + delayTolerance         (pre-update TAT!)
retryAfter = tat - delayTolerance - now
```

where `emissionInterval = per / rate` and `delayTolerance = burst * emissionInterval`.

The admission check is made **once per batch**, against the _pre-update_ TAT. Checking the post-update value instead would reserve the request's cost before deciding, which refuses the very first operation.

## Constructor

| Option    |            Type | Default | Description                                                                          |
| --------- | --------------: | ------: | ------------------------------------------------------------------------------------ |
| `rate`    |        `number` |       — | **Required.** Sustained rate in operations per `per` unit. Must be finite and `> 0`. |
| `per`     |        `number` |  `1000` | The unit `rate` is measured against, in milliseconds.                                |
| `burst`   |        `number` |     `0` | Extra tolerance above the steady-state rate, in operations.                          |
| `onError` | `function(err)` |  `null` | Called instead of throwing when the internal clock misbehaves.                       |

Invalid options throw a `TypeError` at construction.

## API

- `tryConsume(n = 1)` — `true` when the batch fits inside the current budget. A refused attempt does **not** push the next allowed time further out.
- `retryAfter(n = 1)` — exact milliseconds until the next `tryConsume()` would succeed; `0` when it would succeed now.
- `take(n = 1)` — `{ ok: true }` or `{ ok: false, retryAfter }`, in one call.
- `available()` — how many operations can be consumed at this instant, a whole number. At an idle instant this is `burst + 1` (the first operation is always free).
- `hasCapacity` — whether a single operation would be accepted right now. Same shape as `PowerThrottle`'s `available()`, so it drops into `PowerRateLimit` as a limiter component.
- `reset()` — clear accumulated state.
- `stats()` — `{ rate, per, burst, emissionInterval, delayTolerance, tat }`.
- `dispose()` / `[Symbol.dispose]` — clears state.

## Example

```javascript
import { PowerGCRA } from '../src/helpers/powerGCRA.js';

// 100 requests per second, tolerating a 20-request spike.
const limiter = new PowerGCRA({ rate: 100, per: 1000, burst: 20 });

const result = limiter.take();
if (result.ok) {
  doWork();
} else {
  setTimeout(doWork, result.retryAfter); // exact, not a guess
}
```

## Composing limiters

GCRA implements the same `tryConsume()` / `available()` shape as `PowerThrottle` and `PowerSlidingWindow`, so it composes with `PowerRateLimit`:

```javascript
import { PowerGCRA, PowerRateLimit, PowerThrottle } from '../src/index.js';

// A global 200/s ceiling plus a stricter 10/s per-tenant ceiling.
const limiter = new PowerRateLimit([
  new PowerGCRA({ rate: 200, per: 1000, burst: 50 }),
  new PowerThrottle({ limit: 10, windowMs: 1000, capacity: 10 }),
]);

if (limiter.tryConsume()) doWork();
```

Note that `PowerRateLimit`'s pre-check reads `available()` and refuses without calling `tryConsume()` when it is below the ask. That is why `available()` must report `burst + 1` at an idle instant — reporting `0` on a fresh limiter would make GCRA refuse everything once composed.

## Notes

- The limiter is driven by `nowMs()`, which prefers a high-resolution clock. Under fake timers, prefer `vi.advanceTimersByTime(...)` over `vi.setSystemTime(...)`: the latter moves `Date.now()` but not `performance.now()`, and the two can drift apart.
- `retryAfter()` works in fractional milliseconds (e.g. `142.857…` at 7/s), so round **up** if you feed it to a timer that only accepts whole milliseconds.
- A batch is admitted behind a single check, so `retryAfter(n)` does not grow with `n` — waiting the reported amount always suffices for the whole batch.
- `reset()` is a hard clear. It is not a throttle-friendly "refill", which is why it takes no count argument.
