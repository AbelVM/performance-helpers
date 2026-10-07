# PowerThrottle

A small token-bucket rate limiter useful for pacing work (API calls, renders, or cooperating with `PowerPool`).

## Constructor

| option          |                                          type |    default | description                                                                                        |
| --------------- | --------------------------------------------: | ---------: | -------------------------------------------------------------------------------------------------- |
| `capacity`      |                                      `number` |        `1` | Maximum tokens the bucket can hold.                                                                |
| `tokens`        |                                      `number` | `capacity` | Initial token count (clamped to `capacity`).                                                       |
| `refillRate`    |                                      `number` |        `0` | Tokens added per second (fractional accumulation supported).                                       |
| `now`           |                          `function(): number` | `monoMs()` | Clock override in ms. Ignores any per-call value a composition threads in — see [Clocks](#clocks). |
| `observability` | `boolean` \| [`MetricsCollector`](metrics.md) |    `false` | Opt in to metrics. Off by default, so the common case allocates nothing. See [Metrics](#metrics).  |

## API

- `tryConsume(n = 1)` — Attempt to consume `n` tokens (default `1`). Returns `true` when tokens were available and consumed; otherwise returns `false`.

- `available()` — Return the current number of available tokens (performs a refill calculation before reporting).

- `addTokens(n)` — Forcefully add up to `n` tokens to the bucket (clamped to `capacity`). Handy for tests or to manually replenish tokens.

- `reset(count?)` — Reset the token count to `count`. When omitted the bucket is refilled to full `capacity`.

- `reserve(n = 1)` — Reserve `n` tokens without committing them permanently. Returns a token object when successful (useful to later `release()` or `rollback()`), or `null` when reservation fails.

- `release(tokenOrN)` — Release a prior reservation token or numeric token count back into the bucket. Accepts either a token returned from `reserve()` or a numeric value.

- `rollback(nOrToken)` — Alias for `release()` for compatibility with undo patterns.

- `stats()` — Serializable snapshot of `{ capacity, tokens, refillRate }`. **It refills first**, so `tokens` is what the bucket holds _now_ rather than what it held at the last read. See [Metrics](#metrics).

- `getStats()` — Alias for `stats()`.

- `dispose()` — Reset the bucket and release any metrics registration. Use at teardown, including `using` / `await using` scope exit.

## Example

```javascript
import { PowerThrottle } from 'performance-helpers/powerThrottle';

const limiter = new PowerThrottle({ capacity: 5, refillRate: 1 }); // burst 5, 1 token/sec
const pending = [];

async function sendEvent(payload) {
  if (!limiter.tryConsume()) {
    pending.push(payload);
    return;
  }

  try {
    await fetch('https://api.example.com/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error('send failed', error);
    pending.push(payload);
  }
}

const drainInterval = setInterval(async () => {
  while (pending.length && limiter.tryConsume()) {
    const payload = pending.shift();
    await sendEvent(payload);
  }
  if (!pending.length) {
    clearInterval(drainInterval);
  }
}, 250);
```

### Example: cooperating with `PowerPool`

Use a `PowerThrottle` to pace messages enqueued to a `PowerPool` so the pool only processes at most N tasks per second. This is useful when downstream rate limits or external APIs require pacing.

```javascript
// limiter: 3 tokens/sec, burst capacity 3
const limiter = new PowerThrottle({ capacity: 3, refillRate: 3 });
const pool = new PowerPool(MyWorker, { size: 2 });
const pending = [];

function scheduleTask(payload) {
  // tryConsume returns true when a token is available
  if (!limiter.tryConsume()) {
    // requeue for later processing
    pending.push(payload);
    return;
  }
  // dispatch to the pool; optionally target a worker
  pool.postMessage({ task: 'do', payload });
}

// enqueue tasks from some source
for (let i = 0; i < 10; i++) scheduleTask({ i });

// Periodically attempt to drain pending tasks when tokens become available.
const drainInterval = setInterval(() => {
  while (pending.length && limiter.tryConsume()) {
    const p = pending.shift();
    pool.postMessage({ task: 'do', payload: p });
  }
  // stop when no pending tasks
  if (!pending.length) clearInterval(drainInterval);
}, 200);

// drain when done
await pool.drain();
pool.terminate();
```

### Reservation example

You can reserve tokens when you need to prepare work that should only consume a token once the work is actually dispatched. This is useful when coordinating with composed limiters that expect an atomic reservation step.

```javascript
const limiter = new PowerThrottle({ capacity: 2, tokens: 2, refillRate: 0 });
const token = limiter.reserve(1);
if (token) {
  // do preparation work (serialize payload, open resources)
  // when ready to dispatch:
  // if something goes wrong before dispatch, release the reservation
  limiter.release(token);
}
```

### Real-world: reserve before expensive serialization

Use `reserve()` when you want to claim capacity before performing expensive
preparation work (serialization, file reads). If preparation fails, release the
reservation so the token is not consumed.

```javascript
const limiter = new PowerThrottle({ capacity: 3, refillRate: 3 });

async function sendLargePayload(payload) {
  const token = limiter.reserve(1);
  if (!token) {
    // no capacity: fallback (persist, retry later)
    await persistForRetry(payload);
    return false;
  }

  try {
    // expensive synchronous or async serialization
    const body = await heavySerialize(payload);
    // dispatch network call (does not consume extra tokens)
    await fetch('/api/upload', { method: 'POST', body });
    return true;
  } catch (err) {
    // something went wrong during preparation or send
    throw err;
  } finally {
    // always return the reserved token
    limiter.release(token);
  }
}
```

## Clocks

Every limiter reads time, and the clock it reads is **`monoMs()`, not
`nowMs()`** (RES-019). `nowMs()` is two clock reads per call — the
high-resolution one and `Date.now()`, the second purely to check the two have
not diverged under a test harness — and measures about **141 ns**.
`monoMs()` reads **one**, because it never consults `Date.now()` at all, and that
is not only cheaper: it is what stops an NTP adjustment from becoming elapsed
time inside the limiter. See [Which clock](#which-clock) below.

Two knobs address that, and they are deliberately not symmetric:

| Where                     | Type                 | Used by                                                |
| ------------------------- | -------------------- | ------------------------------------------------------ |
| `now` constructor option  | `function(): number` | tests, and any caller driving a fake clock             |
| `{ now }` per-call option | `number`             | `PowerRateLimit`, threading one reading into every leg |

**A limiter constructed with its own `now` ignores any per-call value.** An
explicitly injected clock always wins. The reason is not precedence taste: a
limiter built with a fake clock is a limiter _under test_, and if a composition
overrode its notion of time mid-run, the test would silently start measuring
something else. That is the hardest kind of failure to notice, and it happens
exactly when you are most likely to be looking for a different bug.

A limiter that takes no second argument simply reads its own clock, which is
why threading needs no capability check on the limiter and works with
third-party limiters unchanged.

```javascript
// A driven clock, for anything deterministic.
let clock = 0;
const throttle = new PowerThrottle({ capacity: 10, refillRate: 100, now: () => clock });

// One reading, shared by every leg of a composition.
rateLimit.tryConsume(1, { now: Date.now() });
```

Note the sharp edge: a threaded `now` is **authoritative**, so a value far in the
future will legitimately empty a sliding window. That is correct — it is what a
real clock jumping would do — but it is why a caller should thread one instant
for the whole composition rather than letting each leg drift.

### Which clock

A limiter subtracts readings; it never needs to know what time it is. So its
default clock is `monoMs()`, anchored to the monotonic source
(`performance.now()`, or `process.hrtime.bigint()` on Node) with an epoch offset
captured once at module load. The value is still an epoch timestamp, so
`stats().tat` and `tryReserve().runAt` remain the instants they are documented to
be — but a **wall-clock adjustment cannot move it**.

Measured, with zero real milliseconds elapsed:

| What moved                 | Before                                        | Now                    |
| -------------------------- | --------------------------------------------- | ---------------------- |
| wall clock +5 s            | `available()` 0 -> 2, the whole burst granted | stays 0, still refused |
| `PowerCircuit` open window | `open` -> `half-open` on a +60 s step         | stays `open`           |

The direction matters, because the intuitive version is backwards: a step
_backwards_ was always harmless here (`PowerGCRA` clamps with
`Math.max(now, _tat)`). It is a step **forwards** that hands out budget nobody
spent.

**What this costs you:** faking `Date.now()` no longer drives a limiter. If you
need to control the clock, inject it — the `now` constructor option, or
the per-call `{ now }` for a composition. That has always been the supported
route and it still wins over everything. `PowerCircuit` has no `now` option, so
for that class there was never a documented way in.

## Metrics

```javascript
const throttle = new PowerThrottle({ capacity: 100, refillRate: 10, observability: true });
```

Off by default, so the common case allocates nothing and creates no closure. See
[`metrics.md`](metrics.md) for the collector, and note what this helper does
**not** report.

**`stats()` refills before it reports.** The bucket's `tokens` field is only ever
advanced by a read, so a snapshot taken after a quiet spell would otherwise
report an exhausted bucket that has since refilled to capacity — the wrong
direction to be wrong in, because a dashboard showing "0 available" sends someone
to debug a limiter that is working. `stats()` asks the bucket what it holds now,
the same question `available()` asks.

**There are no allow/refuse counters, and that is deliberate.** Counting requests
would mean incrementing a field on `tryConsume`, the hot synchronous path, for a
feature that is off by default. The bucket's own state is the measurement; how
many requests arrived is yours to count. The same reasoning is why
`PowerGCRA.stats()` reports configuration and TAT rather than admission counts.

`dispose()` detaches, so a torn-down throttle stops being sampled — and one still
answers `stats()` afterwards, so a missed detach would be a series that looks
live and is not, with no error anywhere.
