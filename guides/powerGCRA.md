# PowerGCRA

Generic Cell Rate Algorithm (GCRA) rate limiter — the cell-based scheduler recommended by the ATM Forum, and the algorithm behind `golang.org/x/time/rate`, Redis's `redis-cell` module and the `redis-gcra` Node port.

`PowerGCRA` shapes traffic the same way a token bucket does, but keeps its entire state in **one number**: the _theoretical arrival time_ (TAT). That makes it O(1) per call with no token accumulator and no floating-point drift.

> **Why not just use `PowerThrottle`?** Both are correct rate limiters. GCRA's practical advantages are (a) an **exact** `retryAfter()` rather than an estimate, so it can be handed straight to a backoff or a `Retry-After` header, and (b) one number of state instead of a bucket, a last-refill timestamp and a remainder accumulator. `PowerThrottle` remains the default elsewhere in this library; GCRA is additive and changes nothing about it.

## How it works

```
tat = max(now, tat) + n * emissionInterval          on accept
accept  iff  available() >= n                       (pre-update TAT!)
retryAfter = (n - 1) * emissionInterval - remaining
```

where `emissionInterval = per / rate`, `delayTolerance = burst * emissionInterval`,
and `remaining = delayTolerance - (tat - now)`.

The admission check is made **once per batch**, against the _pre-update_ TAT. Checking the post-update value instead would reserve the request's cost before deciding, which refuses the very first operation.

## Batches

A batch of `n` is admitted only if its **own span** fits inside the delay tolerance. The span of `n` operations is `(n - 1)` emission intervals — the first is free, each subsequent one is spaced a full interval — so `n <= burst + 1` is the requirement, the same one `golang.org/x/time/rate` states as `n <= burst`.

```javascript
const limiter = new PowerGCRA({ rate: 1, per: 1000, burst: 0 });

limiter.available(); // 1 — the first operation is free, burst 0 beyond it
limiter.tryConsume(5); // false — 5 operations at 1/s span 4 seconds
limiter.tryConsume(); // true
```

Two consequences worth knowing:

- **`retryAfter(n)` grows with `n`**, by `(n - 1) * emissionInterval` beyond the single-operation wait. An earlier version reported the single-operation wait for every `n`, which under-waited and was refused — the caller would wake up early and retry, forever.
- **`retryAfter(n)` throws a `RangeError` when `n` is above the ceiling.** A batch past `burst + 1` can never be admitted at _any_ wait, because the ceiling comes from `burst` and not from the state of the TAT. Returning a finite wait for it would be the worst option available: a retry loop would wait, be refused, and wait again. Split the batch, or raise `burst`. `take(n)` propagates rather than inventing a wait.

## Constructor

| Option    |                 Type |    Default | Description                                                                                                                                                                                                                                                                                                                                                             |
| --------- | -------------------: | ---------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rate`    |             `number` |          — | **Required.** Sustained rate in operations per `per` unit. Must be finite and `> 0`.                                                                                                                                                                                                                                                                                    |
| `per`     |             `number` |     `1000` | The unit `rate` is measured against, in milliseconds.                                                                                                                                                                                                                                                                                                                   |
| `burst`   |             `number` |        `0` | Extra tolerance above the steady-state rate, in operations. Fractional values are allowed and floor.                                                                                                                                                                                                                                                                    |
| `onError` |      `function(err)` |     `null` | Called instead of throwing when the **internal clock moves backwards** — NTP, a suspended host, or a test driving an injected clock by hand. Receives the offending reading. It is **not** called when the limiter refuses a request: refusing is what a rate limiter is for, and reporting it made a correctly rate-limiting limiter look broken to anything watching. |
| `now`     | `function(): number` | `monoMs()` | Clock override in ms. Ignores any per-call value a composition threads in — see [Clocks](#clocks).                                                                                                                                                                                                                                                                      |

Invalid options throw a `TypeError` at construction.

## API

- `tryConsume(n = 1)` — `true` when the batch fits inside the current budget, which means `available() >= n`. A refused attempt does **not** push the next allowed time further out. A `n` that is not a finite number throws a `TypeError`; see [Request counts](#request-counts).
- `retryAfter(n = 1)` — exact milliseconds until the next `tryConsume(n)` would succeed; `0` when it would succeed now. Throws a `RangeError` for a `n` above the burst ceiling — see [Batches](#batches).
- `take(n = 1)` — `{ ok: true }` or `{ ok: false, retryAfter }`, in one call.
- `available()` — how many operations can be consumed at this instant, a whole number. At an idle instant this is `burst + 1` (the first operation is always free).
- `hasCapacity` — whether a single operation would be accepted right now. Same shape as `PowerThrottle`'s `available()`, so it drops into `PowerRateLimit` as a limiter component.
- `reset()` — clear accumulated state.
- `stats()` — `{ rate, per, burst, emissionInterval, delayTolerance, tat }`.
- `dispose()` / `[Symbol.dispose]` — clears state.

## Request counts

A count argument is validated, not coerced. `tryConsume(NaN)` used to return `true` having consumed nothing, because `Math.floor(NaN) || 0` makes the count `0` and `0` is the _admit_ case — a rate limiter answering "how many?" with "zero" is a limiter that has been bypassed. Now:

| Input                           | Behaviour             |
| ------------------------------- | --------------------- |
| non-finite (`NaN`, `±Infinity`) | throws `TypeError`    |
| not a number (`'many'`)         | throws `TypeError`    |
| fractional (`3.9`)              | floors to `3`         |
| numeric string (`'3'`)          | read as `3`           |
| `0` or negative                 | no-op, returns `true` |

The fractional case is deliberately _not_ an error, unlike a fractional **limit**. `capacity: 2.5` has to throw because the first consumer rounds it up and over-issues; a request count rounds down and can only under-charge. `0` stays a no-op because refusing to admit nothing would be a behaviour change with no defect behind it.

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

A batch, when the burst covers it:

```javascript
const limiter = new PowerGCRA({ rate: 100, per: 1000, burst: 20 });

limiter.tryConsume(21); // true — burst 20 covers 21 operations back to back
limiter.tryConsume(22); // false — one past the ceiling
limiter.retryAfter(22); // throws RangeError: no wait could ever admit it
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

It is also why `tryConsume(n)` and `available()` must agree _exactly_, including in the last bit of a floating-point comparison. They are now computed by one shared helper for that reason; see [Batches](#batches) and the note on `available()` below.

## Notes

- The limiter is driven by `monoMs()` by default, which reads only a monotonic clock. Under fake timers, prefer `vi.advanceTimersByTime(...)` over `vi.setSystemTime(...)`: the latter moves `Date.now()` alone and no longer reaches this limiter at all. Inject `now` to drive the clock yourself — see [Which clock](#which-clock).
- `retryAfter()` works in fractional milliseconds (e.g. `142.857…` at 7/s), so round **up** if you feed it to a timer that only accepts whole milliseconds.
- `retryAfter(n)` **does** grow with `n`, by `(n - 1) * emissionInterval`. See [Batches](#batches).
- `available()` reports `burst + 1` at an idle instant for every `rate`. It is answered from `burst` directly rather than by dividing `delayTolerance` back by `emissionInterval`, because that division does not round-trip: at `rate: 3, burst: 7` it reads `6.999999999999999` and under-reports by one. A composition holding a saturated GCRA limiter would then refuse a batch the limiter itself admits.
- `reset()` is a hard clear. It is not a throttle-friendly "refill", which is why it takes no count argument.

## Clocks

Every limiter reads time, and the clock it reads is **`monoMs()`, not
`nowMs()`** (RES-019). The full explanation — why `monoMs()` is cheaper, why
`nowMs()` is two reads, and why an injected `now` wins over everything — is in
[PowerThrottle → Clocks](powerThrottle.md#clocks). The summary here is the part
that is specific to this helper:

- The `now` constructor option lets tests drive the TAT clock deterministically.
- A limiter constructed with its own `now` ignores any per-call value. That is
  not precedence taste: a limiter built with a fake clock is a limiter _under
  test_, and a mid-run override would silently start measuring something else.
- Under fake timers, prefer `vi.advanceTimersByTime(...)` over
  `vi.setSystemTime(...)`: the latter moves `Date.now()` alone and no longer
  reaches this limiter at all.
