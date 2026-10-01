# LRU cache with TTL and Memoizer

An in-memory, memory-efficient LRU cache with TTL, weighted eviction and an optional reusable node pool. Includes a small `PowerMemoizer` wrapper built on top of `PowerCache` for memoizing synchronous or Promise-returning functions.

## PowerCache

| option              |                         type |    default | description                                                                                                                                                                                                                                                                                    |
| ------------------- | ---------------------------: | ---------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxEntries`        |                     `number` | `Infinity` | Maximum number of entries to retain. Older entries are evicted when exceeded.                                                                                                                                                                                                                  |
| `maxWeight`         |                     `number` | `Infinity` | Maximum total weight across all entries. Eviction occurs when exceeded.                                                                                                                                                                                                                        |
| `weightFn`          |     `function(value):number` |  `() => 1` | Compute the weight for a value when explicit `weight` not provided to `set`.                                                                                                                                                                                                                   |
| `defaultTTL`        |                     `number` |    `60000` | Default time-to-live (ms) for entries. Use `null`/`Infinity` to disable expiration.                                                                                                                                                                                                            |
| `maxPoolSize`       |                     `number` |     `1000` | Maximum size of the internal node pool used to reuse nodes and reduce GC.                                                                                                                                                                                                                      |
| `rejectOversized`   |                    `boolean` |    `false` | When `true`, inserting an item with weight &gt; `maxWeight` will be rejected.                                                                                                                                                                                                                  |
| `onEvict`           | `function(key,value,reason)` |     `null` | Callback invoked for evicted/deleted/rejected entries. `reason` is `'evicted'                                                                                                                                                                                                                  | 'deleted' | 'rejected-oversized'`. |
| `onExpire`          |        `function(key,value)` |     `null` | Callback invoked when an entry expires due to TTL.                                                                                                                                                                                                                                             |
| `now`               |               `() => number` |  `nowMs()` | Injected clock in milliseconds, matching the limiters and `PowerTTLMap`. Expiry is the one behaviour here that cannot be observed synchronously, so this turns "assert it expired after 100 ms" from a sleep into an exact assertion — see [Testing expiry](#testing-expiry-without-sleeping). |
| `initialPoolSize`   |                     `number` |        `0` | Prefill the internal node pool to reduce early allocations.                                                                                                                                                                                                                                    |
| `maxCleanupPerTick` |                     `number` |      `100` | Max nodes scanned per cleanup tick for `startCleanup()`.                                                                                                                                                                                                                                       |
| `policy`            |              `'lru'\|'slru'` |    `'lru'` | Eviction policy. `'slru'` adds a protected segment (see below). An unknown value falls back to `'lru'`.                                                                                                                                                                                        |
| `admission`         |                     `'none'` |   `'none'` | `'tinylfu'` adds a 4-bit Count-Min frequency filter that refuses an insert when the entry it would evict is still wanted — see [TinyLFU admission](#tinylfu-admission-resisting-a-scan).                                                                                                       |

### API

- `set(key, value, { ttl, weight })` — Add or update an entry. Accepts an optional `{ ttl, weight }` options object; returns `this` on success or `false` when insertion is rejected due to `rejectOversized`.

- `get(key)` — Retrieve the stored value and mark the entry as recently used. Returns the value or `undefined` when missing or expired.

- `peek(key)` — Read the value without affecting recency; returns `value | undefined`. Expired entries it encounters are removed as it goes — see 'Expiry is eager' below.

- `has(key, { ignoreExpiry = false })` — Check whether a key exists and is not expired. When `ignoreExpiry` is true expired entries are considered present. Expired entries the call observes are removed as it goes — see 'Expiry is eager' below.

- `hasEqual(key, value, { ignoreExpiry = false })` — Deep-equality compare the stored value against `value` using optimized fast paths for primitives, typed arrays, Maps/Sets, and cyclic-safe comparison. Respects the `ignoreExpiry` option. **`hasEqualWithSeen` and the `seen` option were removed in 2.0** — the comparison's cycle guard is per-walk state, so a `seen` map reused across two calls made the second return `true` for a pair a previous, unrelated call had recorded, without comparing anything. Pass no `seen`; the primitive and typed-array fast paths never allocate one.

- `delete(key)` — Remove an entry. Returns `true` when a key was removed.

- `clear()` — Remove all entries and return nodes to the internal pool (no return value).

- `cleanupExpiredUpTo(maxScan = Infinity)` — Scan up to `maxScan` nodes for expired entries and remove them; returns the number of nodes scanned in this pass.

- `startCleanup(intervalOrOptions)` — Start a periodic, non-blocking cleanup loop. Accepts either a numeric interval (ms) or `{ interval, maxCleanupPerTick }` options.

- `stopCleanup()` — Stop the periodic cleanup loop and clear internal timers.

- `getOrSet(key, factory, { ttl, weight, staleWhileRevalidate })` — Atomically read-or-compute a value. If `factory` is a function its result (or resolved Promise) is stored and returned. When `staleWhileRevalidate` is enabled, an expired value can be returned immediately while refresh happens in the background.

- `getOrSetAsync(key, asyncFactory, { ttl, weight, staleWhileRevalidate })` — Async read-or-compute with inflight deduplication: concurrent callers share the same in-flight Promise and the resolved value is cached when settled. With `staleWhileRevalidate: true`, an expired cached value is returned immediately and the async factory refreshes the cache behind the scenes.
- `getOrSetAsync(key, asyncFactory, { ttl, weight, staleWhileRevalidate })` — the factory is called as `asyncFactory(signal)` and receives an **`AbortSignal`**, as `fetch` does. It is signalled when the key is **evicted** or **deleted**, when the cache is **cleared**, and when the caller's **timeout** elapses. A factory that ignores the signal is unaffected — aborting is a request, not a kill, and its value is still cached. See [Cancelling an in-flight fetch](#cancelling-an-in-flight-fetch).
- `getOrFetch(key, factory?, options?)` — `getOrSetAsync` using the cache's `fetchMethod` when no per-call factory is given. The reason it exists: a `fetchMethod` on the instance removes a function literal from **every** call site, which is most of the cost of the async API in a hot path. A per-call factory still wins, so one cache can serve more than one kind of resource. Rejects with a `TypeError` if there is neither.

### Stale-while-revalidate, and bounding it

An expired entry is a miss. `staleWhileRevalidate` changes that: it returns the
expired value immediately and refreshes in the background.

**Set a bound.** `staleTtl` is how long past `expiresAt` a stale value may still be
served, and the reason it exists is a measured defect: with the flag alone there was
**no upper bound at all**.

```javascript
const cache = new PowerCache({
  allowStale: true, // stale by default, not at every call site
  staleTtl: 30_000, // ...but never more than 30s past expiry
});

await cache.getOrFetch('user:42', () => fetchUser(42));
```

Measured before the bound existed, with the flag on:

```
+500ms    served: old    refreshes: 0
+1 hour   served: old    refreshes: 1
+30 days  served: old    refreshes: 1
+5 years  served: old    refreshes: 1
```

A value **five years** past its expiry was still returned as "stale", with the
refresh failing silently each time. That is serve-forever-while-refreshing, and it
is the one failure mode the feature must not have: a caller asking for
freshness-while-not-blocking is asking for it for a bounded time.

| configuration                   | behaviour                                         |
| ------------------------------- | ------------------------------------------------- |
| `staleTtl: 0`                   | the feature is off — an expired entry is a miss   |
| `staleTtl: 5000`                | stale within 5s of expiry, then recomputed        |
| `staleTtl: Infinity`            | unbounded, on purpose                             |
| per-call `staleWhileRevalidate` | overrides the instance default in both directions |
| `allowStale` with no `staleTtl` | **throws** — see below                            |

**`Infinity` is the default, deliberately.** The per-call
`staleWhileRevalidate: true` flag already existed and already served stale
unbounded, so defaulting to `0` would have silently switched that off for every
existing caller — the flag would still be passed and nothing would be stale, with
no error to notice. Instead the **new** surface is the safe one: `allowStale`
without a `staleTtl` throws, so the unbounded window cannot be deployed by
omission. `staleTtl: Infinity` stays available for a caller who wants it on purpose.

An unreadable `staleTtl` (`'soon'`, `-1`, `NaN`) also throws rather than being
coerced — an unparsed duration compares false against every entry and would
silently disable the feature, which is the opposite of what a typo asks for.

**Watch `stats().staleServes`.** A stale serve counts as a `hit` _and_ as a
`staleServes`, so the two are distinguishable:

```javascript
cache.stats().hits; //          every serve that succeeded
cache.stats().staleServes; //   the subset that was expired
```

This is the one number worth alerting on. An upstream that starts failing does
not make requests fail — it makes them serve old data, and the hit rate looks
_better_, not worse. Without this counter the failure mode is invisible.

**Concurrency is already handled.** Concurrent callers on one expired key share a
single in-flight fetch: 20 simultaneous `getOrSetAsync` calls run the factory
**once**. That was true before this row and is pinned by a test, because the stale
path is exactly where a regression there would go unnoticed.

```javascript
const cache = new PowerCache({ defaultTTL: 1000 });
cache.set('user:1', { name: 'Alice' }, { ttl: 1000 });

// After the entry expires, staleWhileRevalidate returns the old value immediately
// and refreshes the cache in the background.
const stale = cache.getOrSet('user:1', () => fetchUser(1), {
  staleWhileRevalidate: true,
});
```

- `resize({ maxEntries, maxWeight })` — Change cache caps and trigger eviction as needed.

- `entries(order = 'MRU')` — Iterator yielding `[key, value]` pairs in MRU or LRU order. Useful for debugging or bulk exports.

- `hitRate` (getter) — Convenience fraction `hits / (hits + misses)` (0 when no samples).

- `setMany(entries, { ttl, weight })` — Bulk-insert multiple `[key, value]` pairs; performs a single eviction pass after insertion for efficiency. Applies the **same** per-entry decisions as `set`: `rejectOversized`, the TinyLFU sketch and the admission window. It returns `this` for chaining, so it cannot report a per-entry outcome — a rejected value surfaces as `onEvict` with `'rejected-oversized'` and in `stats().rejected`, whereas `set` returns `false`. Note the default `weightFn` counts _entries_, not bytes, so `rejectOversized` only triggers under a `weightFn` or an explicit `weight` that measures size.

- `getMany(keys, { ignoreExpiry = false })` — Bulk get; returns a `Map` of found keys -> values.

- `touch(key, ttl?)` — Refresh recency and optionally TTL for an existing key; returns `true` when the key existed and was not expired.

- `stats()` — Return runtime statistics object: `{ size, weight, hits, misses, evictions, rejected, poolSize, expirations }`.

- `hitRate` (getter) — Convenience fraction `hits / (hits + misses)` (0 when no samples).

#### Iteration

`PowerCache` implements the iterator protocol. Iterating the cache with `for...of` yields `[key, value]` pairs in MRU order (most-recently-used first):

```javascript
const c = new PowerCache();
c.set('a', 1);
c.set('b', 2);
for (const [k, v] of c) {
  console.log(k, v); // 'b' then 'a'
}
console.log('hit rate', c.hitRate);
```

### Opt-in: eager cleanup on read

**Expiry is eager, and always has been.** Any read that observes an expired
entry removes it: `get()`, `peek()` and `has()` all go through the same node
lookup, which unlinks the node, fires `onExpire`, and counts the expiration. There
is no option for this, because there is nothing to turn on.

An `eagerCleanupOnRead` option was documented here for two releases, promised
exactly this, and did nothing — the behaviour it described was already
unconditional, so setting it changed no observable result. It has been removed
along with its entry in the options table. The statement that the library
"currently defaults to non-mutating read behavior" was the actual error, and it
was here rather than in the code: a reader who believed it would be surprised to
find `onExpire` firing from a `has()`.

```javascript
import { PowerCache } from '../src/helpers/powerCache.js';

const cache = new PowerCache({ defaultTTL: 1 });
cache.set('a', 1, { ttl: 1 });
// wait for expiry
await new Promise((r) => setTimeout(r, 5));
console.log(cache.peek('a')); // undefined; the expired entry is removed
console.log(cache.has('a', { ignoreExpiry: true })); // false (entry was removed)
```

### TTL values are checked, and the boundary is `expiresAt <= now`

`ttl` must be a number of milliseconds, or `null` / `Infinity` for "never
expires". A **numeric string is accepted** — `process.env.TTL` is a string, and
rejecting that would be pedantry — but a value that does not name a duration is a
`TypeError`:

```js
cache.set('k', v, { ttl: 'abc' });
// TypeError: PowerCache: `ttl` must be a finite number of milliseconds or
// Infinity (received "abc").

cache.set('k', v, { ttl: '1000' }); // fine — 1000 ms from now
```

This is not defensive validation for its own sake. `now + ttl` on a non-number is
_string concatenation_, not a failure, so before this check a mistyped TTL stored
`expiresAt === "3000abc"`, every expiry comparison produced `NaN`, and `NaN > x` is
`false` — the entry simply never expired. A typo in a config value disabled expiry
silently, which is the worst direction a cache can fail in.

The same applies to a non-number that `Number()` would happily coerce:
`Number([]) === 0` and `Number(true) === 1`, so `{ ttl: [] }` and `{ ttl: true }`
are rejected rather than read as "expire now" and "one millisecond".

Two boundaries worth knowing, because they are the opposite of what you might
assume:

- An entry is alive **strictly before** its expiry and lapses **at** it. The
  read is `expiresAt <= now`, so `{ ttl: 100 }` is gone at exactly 100 ms.
- `{ ttl: 0 }` means **expire immediately**, not "no expiry". "No expiry" is
  `null`, `Infinity`, or omitting `ttl` — and those store `0` internally, which is
  why the two are easy to conflate and worth a test each.

Note that `PowerTTLMap` uses the _opposite_ boundary: it stores `now + ttl + 1`
and reads back `now > expiresAt`, so it survives exactly at its TTL. Both are
deliberate and pinned independently; do not assume they agree.

Note: expiry is eager on every read path, so the periodic cleanup loop is a
backstop for entries nothing reads again, not the thing that reclaims them.

If you need LRU order, use `Array.from(c.entries('LRU'))` or the `entries('LRU')` iterator directly.

### Example — caching API responses with async factory

```javascript
import { PowerCache } from '../src/helpers/powerCache.js';

// Cache user profiles for 30s to avoid repeated HTTP calls
const cache = new PowerCache({ maxEntries: 5000, defaultTTL: 30_000 });

// Network-only fetch helper (separate from cache logic for clarity)
async function fetchUserProfileFromNetwork(id) {
  const res = await fetch(`https://api.example.com/users/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// High-level cached accessor using getOrSetAsync (inflight dedupe + caching)
async function fetchUserProfile(id) {
  const key = `user:${id}`;
  return cache.getOrSetAsync(key, () => fetchUserProfileFromNetwork(id), { ttl: 30_000 });
}

// Concurrent callers for the same key share the inflight request (deduped)
const [p1, p2] = await Promise.all([fetchUserProfile('alice'), fetchUserProfile('alice')]);

// Stale-while-revalidate: return expired value immediately and refresh in background
const profile = await cache.getOrSetAsync(
  'user:alice',
  () => fetchUserProfileFromNetwork('alice'),
  {
    staleWhileRevalidate: true,
    ttl: 30_000,
  }
);
console.log('profile', profile);

// The cache will not store rejected promises; handle network errors explicitly
try {
  const bob = await fetchUserProfile('bob');
  console.log('bob', bob.name);
} catch (err) {
  console.error('Failed to load profile', err);
}
```

## Eviction policy: `lru` vs `slru`

Plain LRU is **scan-hostile**: one sequential pass over a set of unique keys
evicts the entire working set, because every scanned key is, momentarily, the
most recently used. `policy: 'slru'` (segmented LRU) fixes that by splitting the
list in two:

```
head (probation LRU) … probation-MRU → protected LRU … tail (protected MRU)
```

- A **new** entry lands in the **probation** segment, at its MRU end.
- An **accessed** entry is **promoted** to the **protected** segment.
- Eviction always takes the **probation LRU** first, and only reaches protected
  once probation is drained.

So a key must be touched twice to earn protection, and a one-off scan churns
only in probation.

```javascript
const cache = new PowerCache({ maxEntries: 100, policy: 'slru' });
```

### Measured effect

Establishing a 40-key hot working set and then scanning 500 distinct keys once:

| policy          | hot keys retained after the scan |
| --------------- | -------------------------------: |
| `lru` (default) |                       **0** / 40 |
| `slru`          |                      **40** / 40 |

That comparison is asserted in `test/powerCache.slru.test.js`, so it is enforced
on every CI run rather than being a one-off measurement.

### Trade-offs

- Slightly more work per `get` (one extra pointer comparison per promotion) and
  one extra pointer to maintain on `set`/`delete`.
- `entries('LRU')` still returns a single global order (probation then
  protected); the segment split is an implementation detail, not a change to the
  public ordering.
- **There is deliberately no `protectedRatio` knob.** The split here is decided
  by access history, not by a fixed ratio, so exposing a ratio would be an
  option that does nothing. A ratio only becomes meaningful with an admission
  filter in front of it (a W-TinyLFU style policy), which would be the next
  step up from this one.

## PowerMemoizer

Small memoization helper that uses a `PowerCache` instance internally. It deduplicates concurrent Promise-returning calls and does not cache rejected Promises.

The constructor always returns a `PowerMemoizer` instance. Use the instance method `memoize(fn)` to create a callable memoized wrapper for a function. The returned memoized function has helper methods attached (`get`, `has`, `delete`, `clear`, `stats`, `cache`).

#### Memoizer constructor params

| param                  |                       type |         default | description                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | -------------------------: | --------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fn`                   |                `Function?` |               — | Optional function to register with the instance. The constructor will not return a bare function; call `pm.memoize(fn)` to obtain a memoized wrapper (the instance will create a convenience wrapper accessible via `pm.run()` when `fn` is supplied).                                                                                                                                                 |
| `options.keyResolver`  | `function(...args):string` | `simpleArgsKey` | Function mapping call args to a stable cache key. **Changed in 2.0**: the default was `(...args) => JSON.stringify(args)`, which is ~35% slower for scalar arguments but **aliased distinct arguments onto one key** — `undefined`, functions, and every `Map`/`Set`/`RegExp` all collapsed to `null` or `{}`. See [below](#memoizer). The key _format_ differs, so a caller reading keys will see it. |
| `options.cacheOptions` |                   `Object` |            `{}` | Options forwarded to the underlying `PowerCache` constructor (e.g. `defaultTTL`, `maxEntries`, `weightFn`).                                                                                                                                                                                                                                                                                            |
| `options.ttl`          |                  `number?` |     `undefined` | Default TTL (ms) used when caching results for the `fn` passed to the constructor.                                                                                                                                                                                                                                                                                                                     |
| `options.weight`       |                  `number?` |     `undefined` | Default weight used when caching results for the `fn` passed to the constructor.                                                                                                                                                                                                                                                                                                                       |

You can create an empty `PowerMemoizer` instance and memoize multiple functions that share the same underlying cache by calling `memoize(fn)`:

```javascript
// share a single cache across multiple functions
const pm = new PowerMemoizer();
const memoA = pm.memoize(fnA);
const memoB = pm.memoize(fnB, { ttl: 5000 });
```

### Memoizer API

- `get(...args)` — Retrieve the cached value for the resolved key, or `undefined` when missing.
- `has(...args)` / `delete(...args)` — the same, for presence and removal.

The three helpers are **receiver-aware**, which matters for memoized _methods_. A call with a receiver is cached under a key scoped to that receiver (`memo.call(obj, 10)` stores `r1:10`), so the plain `memo.get(10)` deliberately does not see it — that key belongs to `obj`, not to the function. To reach it, call the helper _with the receiver_:

```javascript
const obj = {
  double(x) {
    return memo.call(this, x);
  },
};
obj.double(10); // caches under obj's scoped key
memo.get(10); // undefined — correct: no plain call was made
memo.get.call(obj, 10); // 20 — the entry obj.double(10) stored
memo.delete.call(obj, 10); // true, and the scoped key is gone
```

Calling a helper plainly — `memo.get(10)` — resolves the **unscoped** key, which is what a plain `memo(10)` call stores, so the documented signature is unchanged. Two receivers holding the same arguments stay independent.

- `clear()` — Clear the memoizer's cache and any inflight markers.

- `memoize(fn)` — Wrap and return a memoized version of `fn` using this instance's cache. The returned function has helper methods attached (`get`, `has`, `delete`, `clear`, `stats`, `cache`).

- `run(...args)` — Convenience alias that invokes the memoized wrapper created from the constructor-supplied function. If the `PowerMemoizer` was constructed without a function, `run()` will throw a `TypeError` instructing callers to use `memoize(fn)`.

- `memoize(fn)` — Wrap and return a memoized version of `fn` using this instance's cache. The returned function has helper methods attached (`get`, `has`, `delete`, `clear`, `stats`, `cache`).

### Example

```javascript
const fetchUserFn = async (id) => fetch(`/users/${id}`).then((r) => r.json());
// when constructing without an immediate function you must pass the
// options as the *second* argument (first arg is the optional `fn`):
const pm = new PowerMemoizer(undefined, { cacheOptions: { defaultTTL: 10_000 } });
const memo = pm.memoize(fetchUserFn);
// call the memoized function directly
await memo(1);
```

### TinyLFU admission: resisting a scan

`{ admission: 'tinylfu' }` adds a frequency filter in front of the cache. The
intent is sound: an LRU admits anything that misses, so a one-off scan over a
larger key space evicts the entire working set — every scan key is the _most
recently used_ by definition. A frequency filter asks a different question: is
the thing I would evict still wanted?

> **Experimental, and currently a net loss. Measured, not assumed.**
> `node bench/claims.js zipf` does not reproduce an earlier claim about this
> option, and inverts it. On a cold 40-entry cache preceded by a 460-key scan
> burst, `admission: 'tynilfu'` measured a **2.5 % hit rate against plain LRU's
> 66.4 %**, retaining **1.7 of 40** working-set keys against LRU's 40/40. On the
> sustained Zipf + scan mix below it is a mild loss. **Do not enable it on the
> strength of the theory — measure your workload first**, and prefer
> `policy: 'slru'`, which resists the same scan and is not experimental.

Sustained Zipf + scan workload — 40-key working set, a 25-key one-shot scan
every 40 hot accesses, 5 paired repeats so every variant sees a byte-identical
key stream (`node bench/claims.js zipf`):

| Configuration                            | Working-set hit rate |     Survivors |
| ---------------------------------------- | -------------------: | ------------: |
| `policy: 'lru'`                          |               75.0 % |     17.2 / 40 |
| `policy: 'lru'`, `admission: 'tinylfu'`  |               70.8 % |     15.0 / 40 |
| **`policy: 'slru'`**                     |           **89.4 %** | **33.0 / 40** |
| `policy: 'slru'`, `admission: 'tinylfu'` |           **89.4 %** | **33.0 / 40** |

`slru` wins outright. The last row is the same measurement as the one above it
for a reason worth knowing: **`admission` is ignored under `policy: 'slru'`**,
because the SLRU probation segment already does the job the filter is for, so
the sketch is never built (`policy !== 'lru'` leaves it `null`) and the two rows
are the same configuration. It previously read 70.9 % / 15.2 here, which was
stale — a measured number that described a build where the sketch was still
constructed for SLRU. Restated from a re-run rather than edited.

That is the result to act on: on this workload the scan-resistant behaviour people want
comes from `slru`, which shipped earlier and is not experimental.

**Off by default**, and the numbers above are the reason to leave it there. The
sketch costs memory and a hash per access; the mechanism is right and the wiring
is not yet.

#### `tinylfu` is a no-op under `policy: 'slru'`

SLRU's probation segment is the same mechanism the sketch provides — both
absorb one-shot traffic before it can reach the main region — and stacking them
is not a weaker version of either but a worse cache. Measured on the workload
above:

| Configuration                            | Working-set hit rate |     Survivors |
| ---------------------------------------- | -------------------: | ------------: |
| `policy: 'slru'`                         |               89.4 % |     33.0 / 40 |
| `policy: 'slru'`, `admission: 'tynilfu'` |           **89.4 %** | **33.0 / 40** |

Before this, the combination measured **70.9 %** — worse than plain LRU — so
composing "the two scan-resistant options" produced the worse of each rather
than the better. Asking for SLRU now gives you SLRU, unchanged, and the option
costs nothing there: no sketch is built, so there is no per-access hash.

This is filed under **Breaking**, because the combination now does _less_ than
it used to. It is doing the right thing.

#### The confirmed defect

The admission check refuses when the incumbent's estimate is `>=` the
challenger's. A brand-new key's estimate is 0, so in a cold sketch — where every
estimate is 0 — **every admission is refused**. A cache that filled with one-shot
scan keys while below capacity therefore cannot recover: the working set is
refused every time, which is the 2.5 % above.

The fix is **not** a comparison operator. Changing `>=` to `>` was implemented
and measured: it improved the sustained mix (70.9 % → 77.0 %, finally beating
plain LRU) but moved the cold-start case only from 2.5 % to 2.7 %, so a scan
walks the working set — the exact failure the feature exists to prevent. It was
reverted.

The mechanism that _is_ built is W-TinyLFU's admission _window_: a small region
at the MRU end that accepts new keys unconditionally, so scan traffic is
absorbed there and the filter arbitrates only that window's victim against a
main-space victim. It is **off by default** (`windowSize: 0`) and documented as
not recommended, because it fixes the sustained case and not the cold one:

| variant                | sustained ws hit rate | cold-start hit rate |
| ---------------------- | --------------------: | ------------------: |
| `lru`                  |                75.0 % |          **80.0 %** |
| `admission: 'tinylfu'` |                70.8 % |               0.0 % |
| + `windowSize: 1`      |            **77.3 %** |               1.5 % |
| + `windowSize: 16`     |                70.7 % |               1.5 % |
| `policy: 'slru'`       |            **89.4 %** |                   — |

Both columns are `node bench/claims.js zipf` and `node bench/claims.js coldstart`.
The window beats plain LRU on the sustained mix and does nothing for the cold
one, because a working-set key arriving into a cold sketch ties with the scan
keys already resident — and a key that is never admitted never accumulates the
frequency that would let it win. `policy: 'slru'` remains the answer to scan
resistance. `adr/0003-tinylfu-admission-window.md` has the full sweep, the
four acceptance criteria, and the two boundary bugs the experiment found.

#### What the sketch itself gets right

Independent of the admission defect, these hold and are worth keeping:

- **The filter only applies at capacity.** Applying it below capacity refuses
  every insert after the first — measured 200 insertions rejected, `size` 1.
  Admission is about what to _displace_, so it needs something to displace.
- **Rejection happens at the insert, not inside the eviction sweep.** Returning
  from `_evictIfNeeded` to reject skipped the sweep and let the cache grow to 77
  entries against a limit of 10.
- **The half-life is `100 × maxEntries`**, not the sketch's own default of 10
  operations — at 10 a reset fired every ten `set`/`get` and halved a working set
  that had only just been learned.
- **Reads count towards frequency**, not just writes, so a read-mostly cache is
  not judged on a history it never had. `clear()` drops the history with the
  entries.

#### A note on how this was diagnosed

Three separate mechanism hypotheses were proposed and **all three were wrong**:
a short half-life, Count-Min collisions inverting the ranking, and a `null`
sketch under a `defaultTTL`. The two that survived were the ones measured
against the shipped path and reproduced across a parameter sweep; the ones that
failed came from synthetic probes that did not resemble the real workload. The
sketch test suite also could not see any of it, because every test built its
sketch with `sampleSize: 1e9`, which disables the half-life reset — so 156 lines
of tests exercised a configuration that never occurs in production. That is
fixed, and the reasoning is kept in `review.md` under BENCH-002 rather than
deleted: a review that silently drops its own wrong conclusions is not a review.

#### The fix, and why it is not written yet

The mechanism is known: W-TinyLFU's admission **window** — a small
unconditional LRU in front of the filtered space, so scan traffic dies in the
window and the filter only ever arbitrates that window's victim against a
main-space victim. The cold-start collapse is impossible by construction,
because a new key is never refused outright.

Two things are genuinely undecided, and both are decisions rather than
mechanics: the **window size** (a 1 %-of-`maxEntries` window is 0.4 entries on
a 40-entry cache, which rounds to the current broken behaviour), and whether
`admission: 'tinylfu'` should be a **no-op under `policy: 'slru'`** — SLRU
already has a probation region doing the same job, and stacking them currently
produces the worst variant measured.

The full argument, including the two measured attempts and the measurements
that killed three other hypotheses, is in
[the design note (ADR 0003)](../adr/0003-tinylfu-admission-window.md). Until it is
resolved, the numbers above stand and the option stays off by default.

### `hasEqual` and deep comparison limits

`hasEqual(key, value, options)` deep-compares a stored value against an
incoming one. It has two explicit limits and an escape hatch.

| Option         |       Type | Default | Description                                                                                   |
| -------------- | ---------: | ------: | --------------------------------------------------------------------------------------------- |
| `ignoreExpiry` |  `boolean` | `false` | Treat an expired entry as present.                                                            |
| `seen`         |  `WeakMap` |       — | Reusable cycle map, for callers doing many comparisons.                                       |
| `maxNodes`     |   `number` | `10000` | Ceiling on how many pairs one comparison will examine.                                        |
| `compareFn`    | `function` |  `null` | `(a, b) => boolean \| undefined`. Return `undefined` for "no opinion" and the walk continues. |

**A class instance never matches a plain object.** Two values with identical
own properties compare `false` when their prototypes differ:

```javascript
class Token {
  constructor(id) {
    this.id = id;
  }
}
cache.set('t', new Token(1));
cache.hasEqual('t', { id: 1 }); // false — different prototype
cache.hasEqual('t', new Token(1)); // true
```

This is deliberate. A prototype is part of what a value _is_: a `Token` and a
bare object literal with the same fields do not satisfy the same contract, and
a cache that called them equal would hand back the wrong one. Two _different_
classes are a different case — they are unequal for the same reason.

If your value has private state or its own notion of equality, the prototype
check is not the obstacle; use `compareFn` below.

**`hasEqual` does not count as a use.** It reads the entry and leaves its
recency untouched, exactly like `peek`. A scan of `hasEqual` calls will
therefore evict the working set under a small cache, in the same way a scan of
`get` calls would — which is the point: an equality check is usually not "recent
use", and treating it as one would let a lookup pattern reshape the eviction
order. If you want both, `get` is the call that should do it.

**Why a node budget, not just a depth limit.** Depth says nothing about width: a
flat array of 50 000 scalars recurses at _depth 2_ and never trips a depth limit,
and comparing two of them blocked the event loop for tens of milliseconds on what
a caller expects to be a cache lookup. Measured after the change, that comparison
is bounded and reports `false`.

**Truncation reports `false`, not `true`.** A false negative costs a recompute; a
false positive hands back the wrong value, and this is a cache. The same applies
if you lower `maxNodes` yourself — a value larger than the budget reports "not
equal", not a guess.

**Reference equality is never rationed.** Passing the _same_ object back is
answered from `a === b` before any budget arithmetic, so storing and re-reading
a large value by reference is still a hit at any `maxNodes`.

**`compareFn` is for values the walk cannot model** — private fields, domain
objects, anything with its own notion of equality:

```javascript
cache.hasEqual('token', incoming, {
  compareFn: (a, b) => (a instanceof Token && b instanceof Token ? a.id === b.id : undefined),
});
```

### Fast key resolver

For hot paths where most calls use simple scalar arguments (ids, numbers, short strings),
use the built-in `simpleArgsKey` helper as a faster alternative to `JSON.stringify`:

```javascript
import { PowerMemoizer, simpleArgsKey } from '../src/helpers/powerCache.js';

const fetchUserFn = async (id) => fetch(`/users/${id}`).then((r) => r.json());
// use the fast resolver for simple scalar args
// when a function is supplied to the constructor the instance provides a
// convenience `run()` alias that invokes the memoized wrapper:
const pm = new PowerMemoizer(fetchUserFn, { keyResolver: simpleArgsKey });
await pm.run(1);
```

`simpleArgsKey` performs a cheap, deterministic, **type-tagged** encoding. Each
argument is encoded on its own — scalars, arrays, plain objects, `Date`,
`RegExp`, `Error`, `Map`, `Set`, `BigInt` and cycles all get a distinct prefix,
so two different arguments can never produce the same key. **It is the default**
as of 2.0; passing it explicitly is still fine and makes the intent obvious at
the call site.

It previously handed the **whole argument list** to `JSON.stringify` as soon as it
met a non-scalar, and that one decision caused four defects, all measured:

| Input                                        | Old key                     | Problem                                                        |
| -------------------------------------------- | --------------------------- | -------------------------------------------------------------- |
| `({a:1}, undefined)` vs `({a:1}, null)`      | `'[{"a":1},null]'` for both | a memoizer served one call's value to the other                |
| `({a:1}, fn)`                                | `'[{"a":1},null]'`          | aliased onto `null`                                            |
| `new Map([[1,2]])` vs `new Map([['a','b']])` | `'[{}]'` for **both**       | every `Map`, `Set`, `RegExp` and `Error` was indistinguishable |
| `{n: 1n}`                                    | threw                       | while a top-level `1n` was supported — one value, two answers  |
| a circular object                            | threw                       | `Converting circular structure to JSON`                        |

The `Map`/`Set`/`RegExp`/`Error` collision was the worst of these: nothing about
those inputs suggests they are unencodable, and a memoizer keyed on one returned
the first one's value for every subsequent one.

**A function argument throws.** Two closures have no comparable identity, and
`String(fn)` is identical text for both, so any encoding would either collide or
be useless. Refusing is the only answer that cannot be wrong — and the throw says
what to do instead: pass a key, or supply a `keyResolver`.

Structurally equal arguments still share an entry, which is the point:

```javascript
simpleArgsKey({ v: 1 }); // === simpleArgsKey({ v: 1 })
simpleArgsKey({ v: 1 }); // !== simpleArgsKey({ v: 2 })
```

The key format for **scalar-only** calls is byte-identical to before, so the
table below still describes the common case; only calls that previously hit the
broken fallback changed.

A memoized call is also down to a single cache lookup rather than `has()` then
`get()`. That pair existed only to tell "absent" from "cached `undefined`", and
it cost a full extra lookup on every call.

Measured A/B in one process, 400k calls against a 64-key working set:

| Path                                           |    Per call |
| ---------------------------------------------- | ----------: |
| 1.x shape (`JSON.stringify` keys, two lookups) |     0.55 us |
| now (`simpleArgsKey`, one lookup)              | **0.26 us** |

**2.1x.** The double lookup was the larger half and is the change the audit did
not ask for; arity specialisation measured at ~0.1% and was not done.

## Cancelling an in-flight fetch

`getOrSetAsync` calls its factory with an `AbortSignal` as the first argument, and
signals it when the work stops being wanted:

```js
const cache = new PowerCache({ maxEntries: 100 });

const user = await cache.getOrSetAsync(`user:${id}`, async (signal) => {
  const res = await fetch(url, { signal }); // the fetch is actually cancelled
  return res.json();
});
```

The signal fires when the key is **evicted** by a later write, when it is
**deleted** or **cleared**, and when the caller's **timeout** elapses. Before this
there was no cancellation path at all: `AbortController` appeared nowhere in
`powerCache.js`, so an evicted key's factory ran to completion and then wrote its
result into a cache that no longer wanted it.

**Aborting is a request, not a kill.** A factory written before this takes no
argument and cannot be stopped; it still completes and its value is still cached.
Refusing to store it would lose work a caller wanted. The signal is there for a
factory that _can_ cooperate.

**The in-flight slot is released at the timeout, and that is deliberate.** An
earlier version held the slot until the factory settled, which stopped a
duplicate factory from starting — and leaked. A factory that never settles
(`() => new Promise(() => {})`) would hold its slot forever, so that key could
never fetch again and every entry accumulated one Map row per hanging factory. A
duplicate costs compute; a permanent slot is a memory leak _and_ a permanently
broken key.

The consequence, stated plainly: **a caller arriving before the timeout joins the
running factory and receives its value; one arriving after it starts a new fetch.**
For the common case — a slow upstream, a long timeout, a retry that wants the value
— the first is what happens. For a factory that ignores the signal, the second
means the work is done twice. That is the residual F-09 named, reduced to
factories that can cooperate.

**A throwing abort listener is the caller's own risk**, exactly as with any
`abort()`. It is worth knowing that a `try`/`catch` around the aborting call does
**not** contain it: `runAbort` re-reports a listener exception on `process.nextTick`,
so it surfaces as an uncaught exception rather than something the cache can catch.

## PowerTimedCache

`PowerTimedCache` is a small convenience wrapper around `PowerCache` for the common
pure-TTL use case. It constructs a `PowerCache` with the provided `ttl` used as
the cache `defaultTTL` and automatically starts the periodic cleanup loop so
callers don't have to wire `startCleanup()` manually.

Use it when you only need simple time-based expiration and want a compact
one-line construction pattern.

Constructor signature

```javascript
new PowerTimedCache(ttl, { maxEntries, interval, maxCleanupPerTick, cacheOptions });
```

| option              |     type |     default | description                                                                                                                                  |
| ------------------- | -------: | ----------: | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ttl`               | `number` |           — | Required. Default TTL (ms) for entries stored in the cache.                                                                                  |
| `maxEntries`        | `number` | `undefined` | Optional: forwarded to the underlying `PowerCache` constructor.                                                                              |
| `interval`          | `number` | `undefined` | Optional cleanup interval (ms). When provided it is forwarded to `startCleanup()`; otherwise `startCleanup()` uses its own computed default. |
| `maxCleanupPerTick` | `number` | `undefined` | Optional: when provided forwarded to `startCleanup()` to control nodes scanned per tick.                                                     |
| `cacheOptions`      | `Object` |        `{}` | Additional options forwarded to `PowerCache` (e.g. `weightFn`, `maxWeight`, `rejectOversized`).                                              |

### Example

```javascript
import { PowerTimedCache } from '../src/helpers/powerCache.js';

// entries expire after 60s; cleanup runs on the default cadence
const tc = new PowerTimedCache(60_000, { maxEntries: 1000 });

tc.set('k', 1);
console.log(tc.get('k'));
```

### Notes

- `PowerTimedCache` delegates all public `PowerCache` instance methods (for example `get`, `set`, `delete`, `clear`, `entries`, `stats`) to the underlying cache. Use `tc.cache` to access the raw `PowerCache` instance when you need advanced operations.
- The wrapper exposes synchronous and async disposal hooks (`[Symbol.dispose]` and `[Symbol.asyncDispose]`) which delegate to the underlying cache

## Recommendations

- Use `PowerCache` for workloads with bounded memory or to avoid repeated expensive computations.
- Provide a `weightFn` when storing large binary-like values to enable weight-based eviction.
- Use `PowerMemoizer` for short-lived Promise caching where concurrent deduplication is desirable. Be careful with `keyResolver` for objects — prefer stable string keys or canonical serializers.

## Testing expiry without sleeping

`PowerCache` is the last helper in the family without an injectable clock, and
it is the one where it matters most: TTL expiry is the only behaviour it has that
cannot be observed synchronously. So the obvious expiry test is a sleep, which
is a guess in both directions — too short and it asserts on a live entry, too
long and every run pays for it.

```js
let clock = 0;
const cache = new PowerCache({ defaultTTL: 100, now: () => clock });
cache.set('k', 'v');
clock = 100;
cache.get('k'); // 'v'  — alive AT its TTL
clock = 102;
cache.get('k'); // undefined
```

`PowerThrottle`, `PowerGCRA`, `PowerSlidingWindow`, `PowerRateLimit` and
`PowerTTLMap` all take the same option, and `test/invariants.test.js` pins the
boundary positions for the two classes whose TTL arithmetic is not obvious — an
entry stored as `now + ttl + 1` and read back as `now > expiresAt`, so it
survives exactly at its TTL and lapses immediately after. A later "simplification"
of that `+ 1` fails there rather than quietly shortening every entry by a
millisecond.
