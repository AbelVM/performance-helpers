[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/powerCache](../README.md) / PowerCache

# Class: PowerCache

PowerCache

In-memory cache with weight-aware eviction, TTLs and optional cleanup.
Provides MRU/LRU iteration helpers and hooks for eviction/expiration.

PowerCache

## Constructors

### Constructor

> **new PowerCache**(`options?`, ...`args?`): `PowerCache`

Create a PowerCache.

The options type is the `PowerCacheOptions` typedef, not a second inline
list. The two had drifted: `defaultAsyncTimeout`, `onError` and `policy`
were destructured here and documented in the typedef, but absent from a
duplicated `@param` list on this constructor - so TypeScript synthesised an
options type without them, the body failed to type-check against its own
signature, and the three options were missing from the published
declarations. One source of truth, not two that have to be kept in step.

#### Parameters

##### options?

`PowerCacheOptions`

##### args?

...`any`[] = `{}`

#### Returns

`PowerCache`

#### Throws

When a non-object is provided as the options argument.

## Properties

### \_cleanupCursor

> **\_cleanupCursor**: `any`

---

### \_cleanupCursorValid

> **\_cleanupCursorValid**: `boolean`

---

### \_cleanupParams

> **\_cleanupParams**: \{ `interval`: `number`; `maxCleanupPerTick`: `number`; \} \| `null`

---

### \_cleanupRunning

> **\_cleanupRunning**: `boolean`

---

### \_cleanupTimer

> **\_cleanupTimer**: `any`

---

### \_currentWeight

> **\_currentWeight**: `number`

---

### \_defaultAsyncTimeout

> **\_defaultAsyncTimeout**: `number`

---

### \_evictionCandidate

> **\_evictionCandidate**: `any`

---

### \_evictions

> **\_evictions**: `number`

---

### \_expirations

> **\_expirations**: `number`

---

### \_head

> **\_head**: `CacheNode` \| `null`

---

### \_hits

> **\_hits**: `number`

---

### \_inflightPromises

> **\_inflightPromises**: `Map`\<`any`, `any`\>

---

### \_map

> **\_map**: `Map`\<`any`, `any`\>

---

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

---

### \_misses

> **\_misses**: `number`

---

### \_now

> **\_now**: () => `number`

Get a high-resolution timestamp in milliseconds since the epoch.

This function prefers `performance.timeOrigin + performance.now()` when
available and reasonably close to `Date.now()` to provide higher
resolution timestamps. On Node.js it uses `process.hrtime.bigint()` with an
epoch offset when available. Falls back to `Date.now()` if nothing
better is available or when offsets appear to diverge (e.g. in some
test harnesses).

#### Returns

`number`

Milliseconds since epoch (floating point for higher resolution).

---

### \_policy

> **\_policy**: `string`

Eviction policy. `'lru'` (default) keeps the previous single-recency-list
behaviour. `'slru'` splits the list into a probation segment and a
protected segment and promotes on access, which makes the cache far more
resistant to a one-off sequential scan evicting the working set.

---

### \_pool

> **\_pool**: `CacheNode`[]

Recycled nodes, kept to avoid allocating one per insert.

Annotated because an empty `[]` takes its element type from whatever is
first pushed into it, and the prefill literal below is a _narrower_ type
than `CacheNode` — which then made every other push into this pool a type
error. The annotation is the fix; the two prefill fields are the rest of
it.

---

### \_probationEnd

> **\_probationEnd**: `CacheNode` \| `null`

MRU end of the probation segment. With `policy: 'slru'` the list is
ordered:

head (probation LRU) ... _probationEnd (probation MRU)
-> protected LRU ... tail (protected MRU)

New entries are spliced in at the probation/protected boundary and a hit
promotes a node to the tail. `null` when the list is empty.

---

### \_rejected

> **\_rejected**: `number`

---

### \_rejectedAdmission

> **\_rejectedAdmission**: `number`

---

### \_tail

> **\_tail**: `any`

---

### \_weightErrors

> **\_weightErrors**: `number`

number of times `weightFn` threw; a non-zero value means `maxWeight`
could not be enforced and should be surfaced by the caller.

---

### defaultTTL

> **defaultTTL**: `number`

---

### maxCleanupPerTick

> **maxCleanupPerTick**: `number`

---

### maxEntries

> **maxEntries**: `number`

---

### maxPoolSize

> **maxPoolSize**: `number`

---

### maxWeight

> **maxWeight**: `number`

---

### onError

> **onError**: ((`arg0`, `arg1`) => `void`) \| `null`

---

### onEvict

> **onEvict**: ((`arg0`, `arg1`, `arg2`) => `void`) \| `null`

---

### onExpire

> **onExpire**: ((`arg0`, `arg1`) => `void`) \| `null`

---

### rejectOversized

> **rejectOversized**: `boolean`

---

### weightFn

> **weightFn**: ((`arg0`) => `number`) \| `null`

## Accessors

### hitRate

#### Get Signature

> **get** **hitRate**(): `number`

Hit rate as a fraction (hits / (hits + misses)).

##### Returns

`number`

---

### size

#### Get Signature

> **get** **size**(): `number`

Current number of entries in cache.

##### Returns

`number`

## Methods

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

Asynchronous disposal hook. Provided for symmetry with `using`/`await using`.
Cache cleanup is synchronous so this simply performs the same actions and
returns a resolved Promise for await compatibility.

#### Returns

`Promise`\<`void`\>

---

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

---

### \[iterator\]()

> **\[iterator\]**(): `IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

#### Returns

`IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

---

### cleanupExpired()

> **cleanupExpired**(): `void`

Remove expired entries by scanning from least-recently used to most.

#### Returns

`void`

---

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

---

### clear()

> **clear**(): `void`

Clear the cache and return nodes to the pool.

#### Returns

`void`

---

### delete()

> **delete**(`key`): `boolean`

Delete an entry from the cache.

#### Parameters

##### key

`any`

#### Returns

`boolean`

true if the key was removed.

---

### dispose()

> **dispose**(): `void`

Named alias for the `Symbol.dispose` implementation, so callers who do not
want to reach for the symbol still have something to call.

#### Returns

`void`

---

### entries()

> **entries**(`order?`): `IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

Iterate entries in LRU or MRU order.

#### Parameters

##### order?

`"LRU"` \| `"MRU"`

#### Returns

`IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

---

### get()

> **get**(`key`): `any`

Retrieve a value and mark it as recently used.

#### Parameters

##### key

`any`

#### Returns

`any`

The stored value or `undefined` if missing/expired.

---

### getMany()

> **getMany**(`keys`, `options?`): `Map`\<`string`, `any`\>

Bulk get multiple keys. Returns a Map of found entries.

#### Parameters

##### keys

`Iterable`\<`any`, `any`, `any`\>

##### options?

###### ignoreExpiry?

`boolean` = `false`

#### Returns

`Map`\<`string`, `any`\>

One entry per resolved key, in input order.

---

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

###### staleWhileRevalidate?

`boolean` = `false`

If true, return an expired value immediately and refresh the cache in the background.

###### ttl?

`number` = `undefined`

###### weight?

`number` = `undefined`

#### Returns

`any`

---

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

###### staleWhileRevalidate?

`boolean` = `false`

If true, return an expired value immediately and refresh the cache in the background.

###### timeout?

`number` = `undefined`

Per-call override of the cache's `defaultAsyncTimeout`, in ms.

###### ttl?

`number` = `undefined`

###### weight?

`number` = `undefined`

#### Returns

`Promise`\<`any`\>

---

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

---

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

`boolean`

If true, consider expired entries as present.

#### Returns

`boolean`

---

### keys()

> **keys**(`order?`): `Generator`\<`any`, `void`, `unknown`\>

Iterate keys in LRU or MRU order.

#### Parameters

##### order?

`"LRU"` \| `"MRU"`

#### Returns

`Generator`\<`any`, `void`, `unknown`\>

---

### peek()

> **peek**(`key`): `any`

Get a value without updating recency.
Returns `undefined` for missing or expired entries.

#### Parameters

##### key

`any`

#### Returns

`any`

---

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

---

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

---

### setMany()

> **setMany**(`entries`, `options?`): `PowerCache`

Bulk set multiple entries. Accepts an iterable/array of [key, value] pairs.
Computes weight once per value and applies a single eviction pass at the end.

The per-entry decisions are `set`'s, not a second set of them: oversize
rejection, the TinyLFU sketch and the admission window are all applied here.
`setMany` used to insert through a simplified path that did none of the
three, so a bulk load was invisible to admission and a rejected value came
back out of the bulk eviction pass wearing the wrong `onEvict` reason.

**It still returns `this`, not `false`, when a value is rejected** — that is
its documented contract for chaining, and changing it would be a breaking API
change for a batch of a thousand entries. The signal is `onEvict` with
`'rejected-oversized'`, and `stats().rejected` afterwards. `set` returns
`false` because it can.

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

---

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

Cleanup interval in ms, or an
options object `{ interval, maxCleanupPerTick }`. The nested tags were
removed because a qualified `@param` is only valid when the parent is a
bare `{Object}`; against `number|Object` it is rejected with TS8032.

#### Returns

`void`

---

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

---

### stopCleanup()

> **stopCleanup**(): `void`

Stop periodic cleanup.

#### Returns

`void`

---

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

---

### values()

> **values**(`order?`): `Generator`\<`any`, `void`, `unknown`\>

Iterate values in LRU or MRU order.

#### Parameters

##### order?

`"LRU"` \| `"MRU"`

#### Returns

`Generator`\<`any`, `void`, `unknown`\>
