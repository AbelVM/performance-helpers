# PowerRateLimit

Compose multiple rate-limiters and require all to allow consumption before proceeding.

## Constructor

`new PowerRateLimit(limiters: Array, options?)`

`limiters` should be an array of limiter instances implementing `tryConsume(n)` and preferably `available()` and `reset()`.

Options:

| Option           |      Type |   Default | Description                                                                                                                            |
| ---------------- | --------: | --------: | -------------------------------------------------------------------------------------------------------------------------------------- |
| `atomic`         | `boolean` |   `false` | When `true` attempts to provide atomic consumes across composed limiters. See **Atomic semantics** below for details and requirements. |
| `now` (per call) |  `number` | `nowMs()` | `tryConsume(n, { now })` and `available({ now })` take **one** reading in ms and thread it into every leg. See [Clocks](#clocks).      |

### Atomic semantics

`PowerRateLimit` supports an `atomic` option that attempts to provide stronger guarantees when consuming tokens across multiple limiters. When `atomic` is enabled (either as a constructor option or per-call via `tryConsume(n, { atomic: true })`) the helper will only succeed when it can ensure either all limiters allow consumption or no limiter is mutated. This requires underlying limiters to expose non-mutating checks (`available()`), or an undo/reservation API (`reserve()` / `release()` / `rollback()` / `addTokens()`). If atomicity cannot be guaranteed the call will return `false` and avoid partial mutations.

## API

- `tryConsume(n?)` — returns `true` only when every underlying limiter permits consuming `n` tokens.
- `reset()` — calls `reset()` on underlying limiters where present.

## Example

```javascript
const limit = new PowerRateLimit([
  new PowerThrottle({ capacity: 100, refillRate: 10 }), // burst limit
  new PowerSlidingWindow({ capacity: 1000, windowMs: 60_000 }), // sustained limit
]);

if (limit.tryConsume()) {
  // proceed: all underlying limiters allowed consumption
}
```

## Clocks

Every limiter reads time, and `nowMs()` is not cheap: it reads **two** clocks
per call — the high-resolution one and `Date.now()`, the second purely to check
the two have not diverged under a test harness — and measures about **141 ns**.
Against a whole `tryConsume` of ~120-165 ns, deciding what time it is was most
of the work.

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
