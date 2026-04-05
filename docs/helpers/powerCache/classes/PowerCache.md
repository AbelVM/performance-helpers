[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerCache](../README.md) / PowerCache

# Class: PowerCache

## Example

```ts
// Create a cache with caps and a simple weight function
const cache = new PowerCache({
  maxEntries: 100,
  maxWeight: 1024 * 1024,
  weightFn: (v) => (v && v.byteLength) ? v.byteLength : 1,
  defaultTTL: 60_000,
  rejectOversized: true
});

// Insert a value with explicit weight and TTL
cache.set('tile:0:0:0', { labels: [] }, { ttl: 5 * 60_000, weight: 1024 });

// Retrieve and mark as used
const val = cache.get('tile:0:0:0');

// Iterate MRU-first
for (const [key, value] of cache.entries('MRU')) { ... }

// Start periodic cleanup every 10s scanning up to 200 nodes per tick
cache.startCleanup({ interval: 10000, maxCleanupPerTick: 200 });

// Inspect stats
logger.log(cache.stats());

@class PowerCache
```

## Constructors

### Constructor

> **new PowerCache**(`options?`): `PowerCache`

Create a PowerCache.

#### Parameters

##### options?

###### defaultTTL?

`number` = `60000`

Default TTL (ms) for entries.

###### initialPoolSize?

`number` = `0`

Prefill the internal node pool with this many nodes (capped by `maxPoolSize`).

###### maxCleanupPerTick?

`number` = `100`

Default max nodes scanned per cleanup tick when running `startCleanup()`.

###### maxEntries?

`number` = `Infinity`

Maximum number of entries.

###### maxPoolSize?

`number` = `1000`

Maximum node pool size for reuse.

###### maxWeight?

`number` = `Infinity`

Maximum total weight across entries.

###### onEvict?

(`arg0`, `arg1`, `arg2`) => `void` = `null`

Callback invoked when an item is evicted/deleted/rejected. Called as `(key, value, reason)` where reason is `'evicted'|'deleted'|'rejected-oversized'`.

###### onExpire?

(`arg0`, `arg1`) => `void` = `null`

Callback invoked when an item expires. Called as `(key, value)`.

###### rejectOversized?

`boolean` = `false`

If true, inserting an item whose weight > `maxWeight` will be rejected.

###### weightFn?

(`arg0`) => `number` = `...`

Function to compute weight for a value.

#### Returns

`PowerCache`

## Properties

### \_cleanupCursor

> **\_cleanupCursor**: `any`

***

### \_cleanupCursorValid

> **\_cleanupCursorValid**: `boolean`

***

### \_cleanupParams

> **\_cleanupParams**: \{ `interval`: `number`; `maxCleanupPerTick`: `number`; \} \| `null`

***

### \_cleanupRunning

> **\_cleanupRunning**: `boolean`

***

### \_cleanupTimer

> **\_cleanupTimer**: `number` \| `null`

***

### \_inflightPromises

> **\_inflightPromises**: `Map`\<`any`, `any`\>

***

### currentWeight

> **currentWeight**: `number`

***

### defaultTTL

> **defaultTTL**: `number`

***

### evictions

> **evictions**: `number`

***

### expirations

> **expirations**: `number`

***

### head

> **head**: [`CacheNode`](../interfaces/CacheNode.md) \| `null`

***

### hits

> **hits**: `number`

***

### map

> **map**: `Map`\<`any`, `any`\>

***

### maxCleanupPerTick

> **maxCleanupPerTick**: `number`

***

### maxEntries

> **maxEntries**: `number`

***

### maxPoolSize

> **maxPoolSize**: `number`

***

### maxWeight

> **maxWeight**: `number`

***

### misses

> **misses**: `number`

***

### onEvict

> **onEvict**: ((`arg0`, `arg1`, `arg2`) => `void`) \| `null`

***

### onExpire

> **onExpire**: ((`arg0`, `arg1`) => `void`) \| `null`

***

### pool

> **pool**: `object`[]

#### expiresAt

> **expiresAt**: `number` = `0`

#### key

> **key**: `null` = `null`

#### next

> **next**: `null` = `null`

#### prev

> **prev**: `null` = `null`

#### value

> **value**: `null` = `null`

#### weight

> **weight**: `number` = `0`

***

### rejected

> **rejected**: `number`

***

### rejectOversized

> **rejectOversized**: `boolean`

***

### tail

> **tail**: [`CacheNode`](../interfaces/CacheNode.md) \| `null`

***

### weightFn

> **weightFn**: (`arg0`) => `number`

#### Parameters

##### arg0

`any`

#### Returns

`number`

## Accessors

### hitRate

#### Get Signature

> **get** **hitRate**(): `number`

Hit rate as a fraction (hits / (hits + misses)).

##### Returns

`number`

***

### size

#### Get Signature

> **get** **size**(): `number`

Current number of entries in cache.

##### Returns

`number`

## Methods

### \[iterator\]()

> **\[iterator\]**(): `IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

#### Returns

`IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

***

### cleanupExpired()

> **cleanupExpired**(): `void`

Remove expired entries by scanning from least-recently used to most.

#### Returns

`void`

***

### cleanupExpiredUpTo()

> **cleanupExpiredUpTo**(`maxScan?`): `number`

Cleanup expired entries, scanning up to `maxScan` nodes.
Scanning resumes from an internal cursor so repeated small passes will cover the list
without repeatedly scanning the head of a very large cache. When the end is reached the
cursor wraps to the head.

#### Parameters

##### maxScan?

`number` = `Infinity`

Maximum nodes to scan in this pass.

#### Returns

`number`

Number of nodes scanned

***

### clear()

> **clear**(): `void`

Clear the cache and return nodes to the pool.

#### Returns

`void`

***

### delete()

> **delete**(`key`): `boolean`

Delete an entry from the cache.

#### Parameters

##### key

`any`

#### Returns

`boolean`

true if the key was removed.

***

### entries()

> **entries**(`order?`): `IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

Iterate entries in LRU or MRU order.

#### Parameters

##### order?

`"LRU"` \| `"MRU"`

#### Returns

`IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

***

### get()

> **get**(`key`): `any`

Retrieve a value and mark it as recently used.

#### Parameters

##### key

`any`

#### Returns

`any`

The stored value or `undefined` if missing/expired.

***

### getMany()

> **getMany**(`keys`, `options?`): `Map`\<`any`, `any`\>

Bulk get multiple keys. Returns a Map of found entries.

#### Parameters

##### keys

`Iterable`\<`any`, `any`, `any`\>

##### options?

###### ignoreExpiry?

`boolean` = `false`

#### Returns

`Map`\<`any`, `any`\>

***

### getOrSet()

> **getOrSet**(`key`, `factory`, `options?`): `any`

Atomically read-or-compute a value for `key`.
If the key is present and not expired the stored value is returned.
Otherwise `factory` is invoked to produce the value which is stored
in the cache and returned. `factory` may be a value (in which case it
is stored directly) or a function. If the function returns a Promise,
the Promise is returned and the resolved value is stored when it settles.

Note: this method does not deduplicate concurrent async factories —
for async factories prefer `getOrSetAsync` or use
`PowerMemoizer` for inflight deduplication.

#### Parameters

##### key

`any`

##### factory

`any`

Function that produces the value or a direct value.

##### options?

###### ttl?

`number` = `undefined`

###### weight?

`number` = `undefined`

#### Returns

`any`

***

### getOrSetAsync()

> **getOrSetAsync**(`key`, `asyncFactory`, `options?`): `Promise`\<`any`\>

Async read-or-compute with inflight deduplication.
If a factory is already running for `key`, returns the same Promise.
Otherwise invokes `asyncFactory` and stores the resolved value in cache.

#### Parameters

##### key

`any`

##### asyncFactory

`Function`

Function returning a Promise or value.

##### options?

###### ttl?

`number` = `undefined`

###### weight?

`number` = `undefined`

#### Returns

`Promise`\<`any`\>

***

### has()

> **has**(`key`, `options?`): `boolean`

Check membership without affecting recency.

#### Parameters

##### key

`any`

##### options?

###### ignoreExpiry?

`boolean` = `false`

If true, consider expired entries as present.

#### Returns

`boolean`

***

### hasEqual()

> **hasEqual**(`key`, `value`, `options?`): `boolean`

Check membership without affecting recency and verify the stored value is deep-equal
to the provided `value`.

Optimizations:
- Fast reference equality short-circuit
- Fast primitive checks
- Special-cases for Arrays, TypedArrays/ArrayBuffer, Date, RegExp, Map and Set
- WeakMap/WeakSet-based cycle detection

#### Parameters

##### key

`any`

##### value

`any`

##### options?

###### ignoreExpiry?

`boolean` = `false`

If true, consider expired entries as present.

#### Returns

`boolean`

***

### keys()

> **keys**(`order?`): `Generator`\<`any`, `void`, `unknown`\>

Iterate keys in LRU or MRU order.

#### Parameters

##### order?

`"LRU"` \| `"MRU"`

#### Returns

`Generator`\<`any`, `void`, `unknown`\>

***

### peek()

> **peek**(`key`): `any`

Get a value without updating recency.
Returns `undefined` for missing or expired entries.

#### Parameters

##### key

`any`

#### Returns

`any`

***

### resize()

> **resize**(`options?`): `void`

Resize the cache limits and evict if necessary.

#### Parameters

##### options?

###### maxEntries?

`number`

###### maxWeight?

`number`

#### Returns

`void`

***

### set()

> **set**(`key`, `value`, `options?`): `false` \| `PowerCache`

Set a value in the cache (add or update).
Marks the entry as most-recently used.
If `rejectOversized` is enabled and the computed/explicit weight exceeds `maxWeight`,
the insertion will be rejected and `set` returns `false` (otherwise returns `this`).

#### Parameters

##### key

`any`

Cache key

##### value

`any`

Value to store

##### options?

###### ttl?

`number` = `...`

Time-to-live in ms. Use `null` or `Infinity` to disable expiration.

###### weight?

`number` = `null`

Optional explicit weight for the entry. If omitted, `weightFn` is used.

#### Returns

`false` \| `PowerCache`

`this` on success, or `false` when insertion was rejected due to oversize.

***

### setMany()

> **setMany**(`entries`, `options?`): `PowerCache`

Bulk set multiple entries. Accepts an iterable/array of [key, value] pairs.
Computes weight once per value and applies a single eviction pass at the end.

#### Parameters

##### entries

`Iterable`\<\[`any`, `any`\], `any`, `any`\>

##### options?

###### ttl?

`number` = `undefined`

###### weight?

`number` = `undefined`

#### Returns

`PowerCache`

***

### startCleanup()

> **startCleanup**(`intervalOrOptions?`): `void`

Start periodic, non-blocking cleanup.
Accepts either a numeric interval (ms) or an options object `{ interval, maxCleanupPerTick }`.
The loop is implemented with `setTimeout` and scans up to `maxCleanupPerTick` nodes per pass
to avoid long event-loop stalls.
Note: call `stopCleanup()` to stop the periodic timer (for example, on application shutdown)
to ensure the internal timer is cleared and resources can be reclaimed.

#### Parameters

##### intervalOrOptions?

`number` \| `Object`

`number`

***

`Object`

#### Returns

`void`

***

### stats()

> **stats**(): `object`

Return runtime statistics for the cache.

#### Returns

`object`

##### evictions

> **evictions**: `number`

##### hits

> **hits**: `number`

##### misses

> **misses**: `number`

##### poolSize

> **poolSize**: `number`

##### rejected

> **rejected**: `number`

##### size

> **size**: `number`

##### weight

> **weight**: `number`

***

### stopCleanup()

> **stopCleanup**(): `void`

Stop periodic cleanup.

#### Returns

`void`

***

### touch()

> **touch**(`key`, `ttl?`): `boolean`

Touch an entry: update its recency and optionally refresh TTL without
reading or modifying the stored value.

#### Parameters

##### key

`any`

##### ttl?

`number` = `undefined`

Optional per-call TTL in ms. Use `null`/`Infinity` to disable expiry.

#### Returns

`boolean`

True if the entry existed (and was not expired), false otherwise.

***

### values()

> **values**(`order?`): `Generator`\<`any`, `void`, `unknown`\>

Iterate values in LRU or MRU order.

#### Parameters

##### order?

`"LRU"` \| `"MRU"`

#### Returns

`Generator`\<`any`, `void`, `unknown`\>
