# PowerRateLimit

Compose multiple rate-limiters and require all to allow consumption before proceeding.

## Constructor

`new PowerRateLimit(limiters: Array, options?)`

`limiters` should be an array of limiter instances implementing `tryConsume(n)` and preferably `available()` and `reset()`.

Options:

| Option           |      Type |    Default | Description                                                                                                                            |
| ---------------- | --------: | ---------: | -------------------------------------------------------------------------------------------------------------------------------------- |
| `atomic`         | `boolean` |    `false` | When `true` attempts to provide atomic consumes across composed limiters. See **Atomic semantics** below for details and requirements. |
| `sharedState`    |  `object` |     `null` | A user-supplied adapter for distributed rate limiting. See **Distributed rate limiting** below.                                        |
| `degrade`        |  `string` |  `'local'` | Policy when `sharedState` throws: `'local'` falls back to local legs, `'fail-closed'` refuses. See **Distributed rate limiting**.      |
| `now` (per call) |  `number` | `monoMs()` | `tryConsume(n, { now })` and `available({ now })` take **one** reading in ms and thread it into every leg. See [Clocks](#clocks).      |

### Atomic semantics

`PowerRateLimit` supports an `atomic` option that attempts to provide stronger guarantees when consuming tokens across multiple limiters. When `atomic` is enabled (either as a constructor option or per-call via `tryConsume(n, { atomic: true })`) the helper will only succeed when it can ensure either all limiters allow consumption or no limiter is mutated. This requires underlying limiters to expose non-mutating checks (`available()`), or an undo/reservation API (`reserve()` / `release()` / `rollback()` / `addTokens()`). If atomicity cannot be guaranteed the call will return `false` and avoid partial mutations.

## API

- `tryConsume(n?)` — returns `true` only when every underlying limiter permits consuming `n` tokens.
- `reset()` — calls `reset()` on underlying limiters where present.
- `dispose()` — releases what the composer built, and supports `using`. See [Disposal](#disposal).
- `stats()` — snapshot of `{ legs, atomic, keyed, buckets, builtSlots, available, rejectionRate }`. `rejectionRate` is the fraction of composed consume calls refused so far. See [Metrics](#metrics).
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

## Distributed rate limiting (GAP-015)

`PowerRateLimit` can consult an external shared store before the local legs,
which is what makes it useful behind a load balancer where every process has
its own heap. The store is user-supplied and must expose one method:

```typescript
interface PowerSharedStateAdapter {
  checkAndIncrement(
    key: string,
    n: number
  ):
    | { ok: true }
    | { ok: false; retryAfterMs?: number }
    | Promise<{ ok: true } | { ok: false; retryAfterMs?: number }>;
}
```

```javascript
const limiter = new PowerRateLimit([new PowerThrottle({ capacity: 100, refillRate: 10 })], {
  sharedState: {
    async checkAndIncrement(key, n) {
      const result = await redis.incrBy(key, n);
      if (result <= 100) return { ok: true };
      return { ok: false, retryAfterMs: 1000 };
    },
  },
  degrade: 'local', // or 'fail-closed'
});
```

The key is derived the same way `keyFn` derives one: from `options.context` when
present, or from the string `'default'` when it is not. That means a keyed
composer can use both `keyFn` and `sharedState` together, and the same key
reaches both the shared store and the per-slot limiter set.

### Degrade policy

A backend error — a timeout, a connection drop, a Redis `MOVED` — is not the
same as a rate-limit refusal. The store said "I cannot answer", not "no". The
`degrade` option chooses what the limiter does next:

| Value           | Behaviour                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `'local'`       | Fall back to the local legs only. The service stays available, but the limit is now per-process. |
| `'fail-closed'` | Refuse the request until the shared store recovers. Safer, but a backend blip becomes an outage. |

`'local'` is the default deliberately: _"failing every request is usually worse
than limiting slightly imperfectly, so the service degrades to a per-process
token bucket: available, but approximate."_ The caller can see which path served
through `stats().path` and the `lastPath` getter.

### Why this respects REJ-008

The library does not ship a Redis client, a Memcached client, or any other
runtime dependency. The user brings the client, and the adapter is a thin
wrapper around it. The N-is-unknown case that sharding cannot cover is handled
by the external store, which knows the actual process count because it sees
every request.

### Async adapters

`checkAndIncrement` may return a promise. When it does, `tryConsume` returns a
promise of the same boolean shape, so the caller's control flow is unchanged:

```javascript
const ok = await limiter.tryConsume(1, { context: { tenant: 'acme' } });
```

The local legs are only consulted after the shared store admits, so an async
adapter does not change the admission order — it only makes the round-trip
visible to the caller.

## External feedback and adaptive refill

The shipped limiters keep `refillRate`, `rate`, and window capacity
deterministic. A local rejection is not evidence that an upstream dependency is
overloaded: it may only mean that this limiter correctly refused work. Do not
auto-tune refill from local rejection without a workload-specific benchmark.

When an upstream supplies a trustworthy signal such as `429`, `Retry-After`, or
an error-budget event, keep the policy in the caller. `PowerAdaptiveProposal`
can produce a bounded, explainable refill proposal, but it does not mutate a
limiter for you:

```javascript
import { PowerAdaptiveProposal, PowerThrottle } from 'performance-helpers';

const throttle = new PowerThrottle({ capacity: 100, refillRate: 20 });
const refill = new PowerAdaptiveProposal({ initial: 20, min: 1, max: 20, maxStep: 2 });

function observeUpstream({ throttled }) {
  const proposal = refill.propose(throttled ? 1 : -0.1);
  if (proposal.changed) throttle.refillRate = proposal.value;
  return proposal;
}
```

The caller must define signal freshness, idempotency, and precedence between
upstream feedback and local pressure. The current benchmark found that a
rejection-driven AIMD candidate admitted less work than fixed refill, so no
adaptive refill mode is enabled by default.

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

Every limiter reads time, and the clock it reads is **`monoMs()`, not
`nowMs()`** (RES-019). The full explanation — why `monoMs()` is cheaper, why
`nowMs()` is two reads, and why an injected `now` wins over everything — is in
[PowerThrottle → Clocks](powerThrottle.md#clocks). The summary here is the part
that is specific to this helper:

- `tryConsume(n, { now })` and `available({ now })` thread **one** reading into
  every leg, so a composition shares a single instant.
- A limiter constructed with its own `now` ignores any per-call value. That is
  not precedence taste: a limiter built with a fake clock is a limiter _under
  test_, and a mid-run override would silently start measuring something else.
