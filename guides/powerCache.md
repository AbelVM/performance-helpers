# LRU cache with TTL and Memoizer

An in-memory, memory-efficient LRU cache with TTL, weighted eviction and an optional reusable node pool. Includes a small `PowerMemoizer` wrapper built on top of `PowerCache` for memoizing synchronous or Promise-returning functions.

## PowerCache

| option | type | default | description |
|---|---:|---:|---|
| `maxEntries` | `number` | `Infinity` | Maximum number of entries to retain. Older entries are evicted when exceeded. |
| `maxWeight` | `number` | `Infinity` | Maximum total weight across all entries. Eviction occurs when exceeded. |
| `weightFn` | `function(value):number` | `() => 1` | Compute the weight for a value when explicit `weight` not provided to `set`. |
| `defaultTTL` | `number` | `60000` | Default time-to-live (ms) for entries. Use `null`/`Infinity` to disable expiration. |
| `maxPoolSize` | `number` | `1000` | Maximum size of the internal node pool used to reuse nodes and reduce GC. |
| `rejectOversized` | `boolean` | `false` | When `true`, inserting an item with weight &gt; `maxWeight` will be rejected. |
| `onEvict` | `function(key,value,reason)` | `null` | Callback invoked for evicted/deleted/rejected entries. `reason` is `'evicted'|'deleted'|'rejected-oversized'`. |
| `onExpire` | `function(key,value)` | `null` | Callback invoked when an entry expires due to TTL. |
| `initialPoolSize` | `number` | `0` | Prefill the internal node pool to reduce early allocations. |
| `maxCleanupPerTick` | `number` | `100` | Max nodes scanned per cleanup tick for `startCleanup()`.
| `eagerCleanupOnRead` | `boolean` | `false` | If `true`, `peek()` and `has()` will remove expired nodes when observed (opt-in behavior). |

### API

- `set(key, value, { ttl, weight })` — Add or update an entry. Accepts an optional `{ ttl, weight }` options object; returns `this` on success or `false` when insertion is rejected due to `rejectOversized`.

- `get(key)` — Retrieve the stored value and mark the entry as recently used. Returns the value or `undefined` when missing or expired.

- `peek(key)` — Read the value without affecting recency; returns `value | undefined`. When the cache is constructed with `eagerCleanupOnRead: true`, `peek()` will remove expired entries it encounters.

- `has(key, { ignoreExpiry = false })` — Check whether a key exists and is not expired. When `ignoreExpiry` is true expired entries are considered present. When `eagerCleanupOnRead: true` the call will remove expired entries seen during the check.

- `hasEqual(key, value, { ignoreExpiry = false, seen })` — Deep-equality compare the stored value against `value` using optimized fast paths for primitives, typed arrays, Maps/Sets, and cyclic-safe comparison. Respects the `ignoreExpiry` option. When performing many comparisons, pass a reusable `WeakMap` as `seen` or use `hasEqualWithSeen(key, value, seen)` to avoid per-call WeakMap allocations.

- `delete(key)` — Remove an entry. Returns `true` when a key was removed.

- `clear()` — Remove all entries and return nodes to the internal pool (no return value).

- `cleanupExpiredUpTo(maxScan = Infinity)` — Scan up to `maxScan` nodes for expired entries and remove them; returns the number of nodes scanned in this pass.

- `startCleanup(intervalOrOptions)` — Start a periodic, non-blocking cleanup loop. Accepts either a numeric interval (ms) or `{ interval, maxCleanupPerTick }` options.

- `stopCleanup()` — Stop the periodic cleanup loop and clear internal timers.

- `getOrSet(key, factory, { ttl, weight })` — Atomically read-or-compute a value. If `factory` is a function its result (or resolved Promise) is stored and returned. Use for synchronous or promise-returning factories when inflight deduplication is not required.

- `getOrSetAsync(key, asyncFactory, { ttl, weight })` — Async read-or-compute with inflight deduplication: concurrent callers share the same in-flight Promise and the resolved value is cached when settled.

- `resize({ maxEntries, maxWeight })` — Change cache caps and trigger eviction as needed.

- `entries(order = 'MRU')` — Iterator yielding `[key, value]` pairs in MRU or LRU order. Useful for debugging or bulk exports.

- `setMany(entries, { ttl, weight })` — Bulk-insert multiple `[key, value]` pairs; performs a single eviction pass after insertion for efficiency.

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
```

### Opt-in: eager cleanup on read

If you prefer reads to automatically remove expired entries when they are observed, construct the cache with `eagerCleanupOnRead: true`. This makes `peek()` and `has()` remove expired nodes seen during the check instead of leaving them until the periodic cleanup.

```javascript
import { PowerCache } from '../src/helpers/powerCache.js';

const cache = new PowerCache({ defaultTTL: 1, eagerCleanupOnRead: true });
cache.set('a', 1, { ttl: 1 });
// wait for expiry
await new Promise((r) => setTimeout(r, 5));
console.log(cache.peek('a')); // undefined; the expired entry is removed
console.log(cache.has('a', { ignoreExpiry: true })); // false (entry was removed)
```

Note: The library currently defaults to non-mutating read behavior (expired entries remain until cleanup). Changing the default to `eagerCleanupOnRead: true` would be a breaking change and should be done as part of a major-version bump.

If you need LRU order, use `Array.from(c.entries('LRU'))` or the `entries('LRU')` iterator directly.

### Example — caching API responses with async factory

```javascript
import { PowerCache } from '../src/helpers/powerCache.js';

// Cache user profiles for 30s to avoid repeated HTTP calls
const cache = new PowerCache({ maxEntries: 5000, defaultTTL: 30_000 });

async function fetchUserProfile(id) {
	return cache.getOrSetAsync(id, async () => {
		const res = await fetch(`https://api.example.com/users/${id}`);
		if (!res.ok) throw new Error('fetch failed');
		return res.json();
	}, { ttl: 30_000 });
}

// Usage
const profile = await fetchUserProfile('alice');
console.log(profile.name, profile.email);
```

## PowerMemoizer

Small memoization helper that uses a `PowerCache` instance internally. It deduplicates concurrent Promise-returning calls and does not cache rejected Promises.

The constructor returns the memoized function directly (callable). The returned function has helper methods attached (`get`, `has`, `delete`, `clear`, `stats`, `cache`).

#### Memoizer constructor params

| param | type | default | description |
|---|---:|---:|---|
| `fn` | `Function?` | — | Optional function to memoize immediately. When provided the constructor returns the callable memoized function instead of a `PowerMemoizer` instance. |
| `options.keyResolver` | `function(...args):string` | `(...args)=>JSON.stringify(args)` | Function mapping call args to a stable cache key. |
| `options.cacheOptions` | `Object` | `{}` | Options forwarded to the underlying `PowerCache` constructor (e.g. `defaultTTL`, `maxEntries`, `weightFn`). |
| `options.ttl` | `number?` | `undefined` | Default TTL (ms) used when caching results for the `fn` passed to the constructor. |
| `options.weight` | `number?` | `undefined` | Default weight used when caching results for the `fn` passed to the constructor. |

You can also create an empty `PowerMemoizer` instance and memoize multiple functions that share the same underlying cache by calling `memoize(fn)`:

```javascript
// share a single cache across multiple functions
const pm = new PowerMemoizer()
const memoA = pm.memoize(fnA)
const memoB = pm.memoize(fnB, { ttl: 5000 })
```

### Memoizer API

- `get(...args)` — Retrieve the cached value for the resolved key, or `undefined` when missing.

- `has(...args)` — Check presence in the memoizer's underlying cache.

- `delete(...args)` — Remove a cached entry and any tracked inflight Promise; returns `true` when removed.

- `clear()` — Clear the memoizer's cache and any inflight markers.

- `memoize(fn)` — Wrap and return a memoized version of `fn` using this instance's cache. The returned function has helper methods attached (`get`, `has`, `delete`, `clear`, `stats`, `cache`).

### Example

```javascript
const fetchUserFn = async (id) => fetch(`/users/${id}`).then(r => r.json())
const memo = new PowerMemoizer(fetchUserFn, { cacheOptions: { defaultTTL: 10_000 } })
// call the memoized function directly
await memo(1)
```

### Fast key resolver

For hot paths where most calls use simple scalar arguments (ids, numbers, short strings),
use the built-in `simpleArgsKey` helper as a faster alternative to `JSON.stringify`:

```javascript
import { PowerMemoizer, simpleArgsKey } from '../src/helpers/powerCache.js'

const fetchUserFn = async (id) => fetch(`/users/${id}`).then(r => r.json())
// use the fast resolver for simple scalar args
const memo = new PowerMemoizer(fetchUserFn, { keyResolver: simpleArgsKey })
await memo(1)
```

`simpleArgsKey` performs a cheap, deterministic encoding for primitive args
and falls back to `JSON.stringify` only when it encounters non-scalar values.

## PowerTimedCache

`PowerTimedCache` is a small convenience wrapper around `PowerCache` for the common
pure-TTL use case. It constructs a `PowerCache` with the provided `ttl` used as
the cache `defaultTTL` and automatically starts the periodic cleanup loop so
callers don't have to wire `startCleanup()` manually.

Use it when you only need simple time-based expiration and want a compact
one-line construction pattern.

Constructor signature

```javascript
new PowerTimedCache(ttl, { maxEntries, interval, maxCleanupPerTick, cacheOptions })
```

| option | type | default | description |
|---|---:|---:|---|
| `ttl` | `number` | — | Required. Default TTL (ms) for entries stored in the cache. |
| `maxEntries` | `number` | `undefined` | Optional: forwarded to the underlying `PowerCache` constructor. |
| `interval` | `number` | `undefined` | Optional cleanup interval (ms). When provided it is forwarded to `startCleanup()`; otherwise `startCleanup()` uses its own computed default. |
| `maxCleanupPerTick` | `number` | `undefined` | Optional: when provided forwarded to `startCleanup()` to control nodes scanned per tick. |
| `cacheOptions` | `Object` | `{}` | Additional options forwarded to `PowerCache` (e.g. `weightFn`, `maxWeight`, `rejectOversized`). |

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
