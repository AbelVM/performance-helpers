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

### API

| method | params | returns | description |
|---|---|---|---|
| `set(key, value, { ttl, weight })` | `key`, `value`, `options` | `this \| false` | Add or update an entry. Returns `false` if rejected due to `rejectOversized`. |
| `get(key)` | `key` | `value \| undefined` | Retrieve and mark entry as recently used; expired entries are removed. |
| `peek(key)` | `key` | `value \| undefined` | Retrieve without affecting recency. |
| `has(key, { ignoreExpiry=false })` | `key`, `options` | `boolean` | Check presence; can optionally ignore expiry. |
| `hasEqual(key, value, { ignoreExpiry=false })` | `key`, `value` | `boolean` | Deep-equality check of stored value vs provided value. |
| `delete(key)` | `key` | `boolean` | Remove an entry; returns `true` when removed. |
| `clear()` | — | `void` | Remove all entries and return nodes to the pool. |
| `cleanupExpiredUpTo(maxScan=Infinity)` | `maxScan` | `number` | Scan and remove up to `maxScan` expired nodes; returns number scanned. |
| `startCleanup(intervalOrOptions)` | `number\|object` | `void` | Start periodic non-blocking cleanup loop. |
| `stopCleanup()` | — | `void` | Stop periodic cleanup. |
| `getOrSet(key, factory, options)` | `key, factory, { ttl, weight }` | `value\|Promise<value>` | Atomically read-or-compute a value; if `factory` returns a Promise it is stored when resolved. Eliminates the common race pattern of `if (!cache.has(k)) cache.set(k, compute())`|
| `getOrSetAsync(key, asyncFactory, options)` | `key, asyncFactory, { ttl, weight }` | `Promise<value>` | Async read-or-compute with inflight deduplication; concurrent callers share the same in-flight Promise. |
| `resize({ maxEntries, maxWeight })` | `options` | `void` | Change caps and trigger eviction if needed. |
| `entries(order='MRU')` | `order` | `IterableIterator<[key,value]>` | Iterate entries in MRU or LRU order. |
| `setMany(entries, { ttl, weight })` | `Iterable<[key,value]>, options` | `this` | Bulk set multiple entries; performs a single eviction pass after insertion. |
| `getMany(keys, { ignoreExpiry=false })` | `Iterable<key>, options` | `Map` | Bulk get; returns a `Map` of found keys -> values. |
| `touch(key, ttl?)` | `key, ttl?` | `boolean` | Update recency of `key` and optionally refresh TTL without reading the value. Returns `true` when the key existed and was not expired, `false` otherwise. |
| `stats()` | — | `object` | Return runtime stats (`size`, `weight`, `hits`, `misses`, `evictions`, `rejected`, `poolSize`). |
| `hitRate` | — | `number` | Convenience getter returning `hits / (hits + misses)` (0 when no samples). |

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

If you need LRU order, use `Array.from(c.entries('LRU'))` or the `entries('LRU')` iterator directly.

### Example

```javascript
const cache = new PowerCache({ maxEntries: 100, defaultTTL: 5_000 })
cache.set('x', { hello: 'world' })
console.log(cache.get('x'))
```

## PowerMemoizer

Small memoization helper that uses a `PowerCache` instance internally. It deduplicates concurrent Promise-returning calls and does not cache rejected Promises.

The constructor returns the memoized function directly (callable). The returned function has helper methods attached (`get`, `has`, `delete`, `clear`, `stats`, `cache`).

| param | type | default | description |
|---|---:|---:|---|
| `fn` | `Function` |  | Optional function to memoize. The constructor returns the callable memoized function (instead of a `PowerMemoizer` instance). |
| `options.keyResolver` | `function(...args):string` | `(...args)=>JSON.stringify(args)` | Function mapping call args to a stable cache key. |
| `options.cacheOptions` | `Object` | `{}` | Options forwarded to the underlying `PowerCache` constructor. |
| `options.ttl` | `number` | `undefined` | Default TTL (ms) used when caching results for the `fn` passed to the constructor (overrides cache default for this wrapper). |
| `options.weight` | `number` | `undefined` | Default weight used when caching results for the `fn` passed to the constructor. |

You can also create an empty `PowerMemoizer` instance and memoize multiple functions that share the same underlying cache by calling `memoize(fn)`:

```javascript
// share a single cache across multiple functions
const pm = new PowerMemoizer()
const memoA = pm.memoize(fnA)
const memoB = pm.memoize(fnB, { ttl: 5000 })
```

### API

| method | params | returns | description |
|---|---|---|---|
| `get(...args)` | `...args` | `value|undefined` | Read cached value by resolved key. |
| `has(...args)` | `...args` | `boolean` | Check presence. |
| `delete(...args)` | `...args` | `boolean` | Remove cached entry and any inflight Promise. |
| `clear()` | — | `void` | Clear cache and inflight markers. |
| `mwmoize(fn)` | `fn` | `function` | Attach a new function to an existing underliying cache |

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

## Recommendations

- Use `PowerCache` for workloads with bounded memory or to avoid repeated expensive computations.
- Provide a `weightFn` when storing large binary-like values to enable weight-based eviction.
- Use `PowerMemoizer` for short-lived Promise caching where concurrent deduplication is desirable. Be careful with `keyResolver` for objects — prefer stable string keys or canonical serializers.
