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
- `dispose()` — releases what the composer built, and supports `using`. See [Disposal](#disposal).
- `stats()` — snapshot of `{ legs, atomic, keyed, buckets, builtSlots, available }`. See [Metrics](#metrics).
- `getStats()` — Alias for `stats()`.
- `limitersFor(key)` — with `keyFn`, the limiter set for one key, so you can inspect or drive that key directly (for a `Retry-After` header, say). Returns `null` without `keyFn`.

## Per-key limiting

One limiter is one limit. Limiting per tenant, per IP or per user means giving
each key its own budget, which is what `keyFn` is for.

```javascript
const limiter = new PowerRateLimit(
  [() => new PowerGCRA({ rate: 10, per: 1000 })], // a factory, not an instance
  { keyFn: (ctx) => ctx.tenant, buckets: 1024 }
);

limiter.tryConsume(1, { context: { tenant: 'acme' } }); // acme's own budget
limiter.tryConsume(1, { context: { tenant: 'globex' } }); // unaffected by acme
```

Note the two shape changes: each entry is a **factory** `(slotIndex) => limiter`,
because a shared instance cannot hold per-key budgets, and the key arrives as a
per-call `context` that `keyFn` reads.

### Why keys are hashed into slots, and not stored

The obvious implementations are both wrong, in **opposite** directions, and both
are reachable with attacker-controlled input:

- **A `Map` of per-key limiters** grows with the key space. Measured: 50 000
  distinct tenants produced 50 000 resident limiters. A memory-exhaustion
  surface reachable from a header.
- **An LRU of per-key limiters** is worse than no bound at all, because evicting
  a limiter **discards that key's consumed budget with it**. A tenant evicted
  while quiet comes back to a brand-new limiter with a full fresh allowance — a
  rate-limit bypass, not a cache miss, and it penalises exactly the tenants that
  behaved. (`PowerCache` is the obvious tool here, which is precisely why it is
  the wrong one.)

So keys are hashed into a **fixed array of `buckets` slots**, each building its
limiter set on first use. Measured: 1 000 000 distinct keys allocate exactly
1024 limiter sets. Nothing is ever evicted, so **no request can have its budget
reset** — the bypass above is structurally impossible rather than merely
unlikely.

### The cost: colliding keys share a budget

This is nginx's `limit_req` model, and the trade is deliberate: for a limiter
whose input is untrusted, a bounded approximation beats an exact answer you
cannot afford to keep. But two keys hashing to the same slot **do share a
budget**, so:

- `buckets` is the knob. Raising it reduces collisions; measured over 100 000
  keys into 1024 slots, every slot was used with max/mean 1.39× — no hot spot.
- A caller who needs strict per-key isolation should pick `buckets` large enough
  for the key space they expect, or keep one limiter outside this class.
- **A missing `context` degrades to one shared limit, not to no limit.** A caller
  who forgets to pass `context` is throttled rather than unlimited, which is the
  direction that fails safe.

`reset()` clears the budgets of every built slot but **keeps the slots** —
discarding them would hand every key a fresh allowance, which is the same bypass
reached deliberately.

## Request counts

`tryConsume` and `reserve` **validate** `n` before anything else, and that ordering is load-bearing rather than incidental. The count used to be coerced with `Math.max(0, Math.floor(+n) || 0)` _after_ a `want === 0` early return, so `tryConsume(NaN)` returned `true` while **no limiter in the composition was consulted at all** — a caller with three limiters behind one composition would have believed it admitted a request no leg ever saw. The assertion now runs first.

| Input                           | Behaviour             |
| ------------------------------- | --------------------- |
| non-finite (`NaN`, `±Infinity`) | throws `TypeError`    |
| not a number (`'many'`)         | throws `TypeError`    |
| fractional (`3.9`)              | floors to `3`         |
| numeric string (`'3'`)          | read as `3`           |
| `0` or negative                 | no-op, returns `true` |

The error message names `PowerRateLimit.tryConsume()`, not the leg that refused, because the failure happens before the legs are reached.

`release()` / `rollback()` still coerce, on purpose. They are the _undo_ path, and a count that cannot be read returns nothing — over-charging the caller, which is the safe direction. Admitting a request you cannot price is the unsafe one.

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

## Disposal

`PowerRateLimit` implements `dispose()` and `[Symbol.dispose]`, so it works with
`using` / `await using` and with a DI container's teardown, like every other
long-lived limiter here.

```javascript
{
  using limit = new PowerRateLimit([() => new PowerGCRA({ rate: 10, per: 1000 })], {
    keyFn: (ctx) => ctx.tenant,
  });
  limit.tryConsume(1, { context: { tenant: 'acme' } });
} // dispose() runs here
```

**There is no timer to cancel.** Each leg refills lazily, computing elapsed time
from a stored timestamp whenever it is read, so `dispose()` is a state release
rather than a cleanup. Saying it "cancels the interval" would describe work that
is not happening.

**With `keyFn`, it drops the lazily built per-slot limiter sets** — the largest
thing a rate limiter in this library holds, since slots are addressed by a hash of
a key the caller usually derived from a request header. `reset()` alone cannot
release them: it walks every built slot calling `reset()` on each leg and leaves
all of them resident.

Your own `limiters` are reset, not discarded. They were passed in, so they are
yours to reuse.

### Disposing and reusing a keyed composer resets every tenant

Worth stating plainly, because it is the one sharp edge here: after `dispose()`, a
later call rebuilds its slot as a **fresh, empty** limiter. So dispose-then-reuse
hands every built key a full allowance.

That is the same "eviction is a reset" bypass [slots are never evicted](#why-keys-are-hashed-into-slots-and-not-stored)
to avoid, and it is allowed here only because the two situations differ: a slot
is never discarded _while the instance is live_, whereas `dispose()` is the
caller saying it is finished. Keeping slots resident after teardown would be the
memory a dispose exists to release.

So: **treat `dispose()` as teardown.** If you want to pause a limiter for a while,
use `reset()`, which is reversible and deliberately does not unregister or drop
anything.

`dispose()` also detaches any metrics registration, so a torn-down composer stops
being sampled — see below.

## Metrics

```javascript
const limit = new PowerRateLimit([new PowerThrottle({ capacity: 100 })], { observability: true });
```

Off by default, so the common case allocates nothing. See
[`metrics.md`](metrics.md).

**`stats().available` is `null` whenever `keyFn` is set, and that is the field
worth reading twice.** Each key has its own budget and a snapshot has no key to
measure, so there is no single number. The obvious alternative — measure the
shared default slot, as `tryConsume` does when no key is given — would report one
arbitrary tenant's allowance as _the composition's_, which is the number least
likely to be believed and most likely to be believed wrongly.

`null` is the honest reading, and the collector preserves it as an explicit
absence rather than dropping the key, so "this composition has no single
availability" stays distinguishable from "this field was never measured". For one
key, use `available({ context })`; for a picture of how many tenants are being
tracked, `builtSlots / buckets` is the occupancy, and at `1.0` every slot has been
touched and further tenants share budgets with existing ones.

There are no allow/refuse counters, for the same reason as on every other helper
here: a field increment on `tryConsume` is cost paid on the hot synchronous path
by a feature that is off by default.

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
