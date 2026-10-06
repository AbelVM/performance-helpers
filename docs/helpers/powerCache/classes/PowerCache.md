[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerCache](../README.md) / PowerCache

# Class: PowerCache

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

> **\_cleanupCursor**: `CacheNode` \| `null`

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

> **\_cleanupTimer**: `any`

***

### \_currentWeight

> **\_currentWeight**: `number`

***

### \_defaultAsyncTimeout

> **\_defaultAsyncTimeout**: `number`

***

### \_evictionCandidate

> **\_evictionCandidate**: `any`

***

### \_evictions

> **\_evictions**: `number`

***

### \_expirations

> **\_expirations**: `number`

***

### \_head

> **\_head**: `CacheNode` \| `null`

***

### \_hits

> **\_hits**: `number`

***

### \_inflightControllers

> **\_inflightControllers**: `Map`\<`any`, `any`\>

***

### \_inflightPromises

> **\_inflightPromises**: `Map`\<`any`, `any`\>

***

### \_map

> **\_map**: `Map`\<`any`, `any`\>

***

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

***

### \_misses

> **\_misses**: `number`

***

### \_now

> **\_now**: () => `number`

Get a high-resolution timestamp in milliseconds since the epoch.

This function prefers `performance.timeOrigin + performance.now()` when
available and reasonably close to `Date.now()` to provide higher resolution
timestamps. On Node.js it uses `process.hrtime.bigint()` with an epoch offset
when available. Falls back to `Date.now()` if nothing
better is available or when offsets appear to diverge (e.g. in some
test harnesses).

**The wall-clock cross-check is what makes this clock movable, and that is
sometimes required.** It is what lets a test harness that fakes `Date.now()`
drive a helper's notion of time, and it is why `PowerCron.nextRunAt` can be
documented as epoch milliseconds. The price is that a helper which only ever
*subtracts* inherits the wall clock's ability to jump - see
[monoMs](../../../utils/now/functions/monoMs.md) for the measurement and for the four helpers that use it
instead.

#### Returns

`number`

Milliseconds since epoch (floating point for higher resolution).

***

### \_policy

> **\_policy**: `string`

Eviction policy. `'lru'` (default) keeps the previous single-recency-list
behaviour. `'slru'` splits the list into a probation segment and a
protected segment and promotes on access, which makes the cache far more
resistant to a one-off sequential scan evicting the working set.
`'sieve'` uses the SIEVE algorithm (NSDI '24): a FIFO queue with a
visited bit per entry and a scanning hand pointer. On eviction, the hand
scans toward the head; visited entries get their bit cleared (second
chance), unvisited entries are evicted.

***

### \_pool

> **\_pool**: `CacheNode`[]

Recycled nodes, kept to avoid allocating one per insert.

Annotated because an empty `[]` takes its element type from whatever is
first pushed into it, and the prefill literal below is a *narrower* type
than `CacheNode` — which then made every other push into this pool a type
error. The annotation is the fix; the two prefill fields are the rest of
it.

***

### \_probationEnd

> **\_probationEnd**: `CacheNode` \| `null`

MRU end of the probation segment. With `policy: 'slru'` the list is
ordered:

  head (probation LRU) ... _probationEnd (probation MRU)
       -> protected LRU ... tail (protected MRU)

New entries are spliced in at the probation/protected boundary and a hit
promotes a node to the tail. `null` when the list is empty.

***

### \_refreshesSkipped

> **\_refreshesSkipped**: `number`

***

### \_rejected

> **\_rejected**: `number`

***

### \_rejectedAdmission

> **\_rejectedAdmission**: `number`

***

### \_sieveHand

> **\_sieveHand**: `CacheNode` \| `null`

SIEVE eviction hand pointer. Scans from tail toward head during eviction.
Visited entries get a second chance (bit cleared), unvisited are evicted.

***

### \_staleServes

> **\_staleServes**: `number`

Serves of an **expired** value, from the stale-while-revalidate path.

Separate from `_hits` because a stale serve is the one case where the cache
answered without having fresh data, and a caller cannot otherwise tell
it apart from a real hit. Operating stale-while-revalidate blind to that
rate is how a broken upstream turns into a silently wrong service: every
request is "successful" and the numbers look like a warm cache.

A subset of `_hits` — a stale serve still counts as a hit, because from the
caller's side it was served.

***

### \_tail

> **\_tail**: `CacheNode` \| `null`

***

### \_weightErrors

> **\_weightErrors**: `number`

number of times `weightFn` threw; a non-zero value means `maxWeight`
 could not be enforced. It used to say "should be surfaced by the caller"
 and could not be, because nothing in `stats()` carried it (CACHE-011);
 `stats().weightErrors` is where a caller reads it now, and `attach()`
 flattens that into a metric series.

***

### \_windowStartMemo

> **\_windowStartMemo**: `CacheNode` \| `null`

***

### \_windowTail

> **\_windowTail**: `CacheNode` \| `null`

***

### allowStale

> **allowStale**: `boolean`

Serve a stale value on `getOrSet`/`getOrSetAsync` by default, so a caller
does not have to pass `staleWhileRevalidate` at every call site. The
per-call flag still wins, and `false` here does not remove the per-call
option - it only stops it being the default.

***

### defaultTTL

> **defaultTTL**: `number`

***

### fetchMethod

> **fetchMethod**: `Function` \| `null`

***

### maxCleanupPerTick

> **maxCleanupPerTick**: `number`

***

### maxEntries

> **maxEntries**: `number`

***

### maxInflightRefreshes

> **maxInflightRefreshes**: `number`

***

### maxPoolSize

> **maxPoolSize**: `number`

***

### maxWeight

> **maxWeight**: `number`

***

### onError

> **onError**: ((`arg0`, `arg1`) => `void`) \| `null`

***

### onEvict

> **onEvict**: ((`arg0`, `arg1`, `arg2`) => `void`) \| `null`

***

### onExpire

> **onExpire**: ((`arg0`, `arg1`) => `void`) \| `null`

***

### rejectOversized

> **rejectOversized**: `boolean`

***

### staleTtl

> **staleTtl**: `number`

***

### weightFn

> **weightFn**: ((`arg0`) => `number`) \| `null`

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

### \_fetchValidNode()

> `protected` **\_fetchValidNode**(`key`, `options?`): `CacheNode` \| `null`

Fetch a node and validate expiry.

#### Parameters

##### key

`any`

##### options?

###### allowExpired?

`boolean` = `false`

Return an expired node instead
  of `null`. Read by `_fetchValidNode` and passed by `getOrSet` when
  `staleWhileRevalidate` is on; previously read but never documented, so it
  was missing from the declared options type.

###### countMiss?

`boolean` = `false`

###### ignoreExpiry?

`boolean` = `false`

###### now?

`number`

A clock reading the caller has already taken.
  Threading it in halves the clock reads on the hot path (PERF-003):
  `getOrSet` and `touch` each read the clock and then called this, which read
  it again — and `utils/now.js` puts `nowMs()` at 141 ns and calls it "on the
  hot path of essentially every helper". Omit it and this reads its own, so
  the callers that have no reading to pass are unaffected.

#### Returns

`CacheNode` \| `null`

***

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

Asynchronous disposal hook. Provided for symmetry with `using`/`await using`.
Cache cleanup is synchronous so this simply performs the same actions and
returns a resolved Promise for await compatibility.

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

***

### \[iterator\]()

> **\[iterator\]**(): `IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

#### Returns

`IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

***

### cleanupExpired()

> **cleanupExpired**(): `number`

#### Returns

`number`

How many expired entries the sweep removed.

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

### dispose()

> **dispose**(): `void`

Named alias for the `Symbol.dispose` implementation, so callers who do not
want to reach for the symbol still have something to call.

#### Returns

`void`

***

### entries()

> **entries**(`order?`): `IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

Iterate entries in LRU or MRU order.

**Mutating the cache from inside the loop is supported, and the walk reads
the next link *before* each `yield` rather than after.** A walk that advanced
after the resume was silently cut short by any mutation of the node the
iterator was standing on, because `_remove` nulls both links on the node it
removes — so `for (const [k] of cache.entries()) cache.delete(k)`, the most
natural way to write "empty this cache", removed exactly one entry and left
the rest, while `size` reported the truth afterwards so nothing raised.
`cleanupExpired()` called from inside the loop was worse, because a caller
has no reason to know that calling a public maintenance method is a
mutation: a bulk export that swept each turn silently exported nothing.

The contract, since a live iterator that can skip is only a legitimate
choice when it is a stated one:

- Removing the entry currently being visited continues at the next one.
- Removing an entry not yet visited skips it (it is gone), and the walk
  completes.
- Entries *added* during the walk are not visited: the walk started at the
  then-tail, and inserting an entry moves the tail out from under it.
- Removing two *adjacent* entries in one iteration step may end the walk
  early. That is the one residual loss, it needs two removals before a
  single resume, and closing it would mean snapshotting the walk into an
  array — an allocation on every call to a bulk-export API.

**A recency mutation (`get()`, `touch()`, or `set()` on a key already in the
list) relinks the entry to the MRU end, which is behind an MRU-first cursor,
so the walk arrives back at it.** Left alone that is an infinite loop, not a
wrong answer, and it was reachable from one line of loop body. The walk now
visits at most as many entries as existed when it started, which ends the
cycle; the entries beyond that point are *not* reported, so a loop that
refreshes recency as it goes sees a prefix rather than a full pass. Collect
the keys first (`Array.from(cache.keys())`) if you need every entry.

#### Parameters

##### order?

`"LRU"` \| `"MRU"`

#### Returns

`IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

***

### evict()

> **evict**(`count?`): `number`

Evict up to `count` entries, least-recently-used first, and return how many
went.

Distinct from the sweep `maxEntries` drives, which evicts until the cache is
*within* its limit and reports no number. This is the explicit version: a
caller shedding memory before a spike, or after a deploy, wants a count and a
return value, not a cache that happens to be smaller.

`count` above the current size removes everything and reports the real
number removed rather than the number asked for — reporting the request
would make `evict(1e9)` on an empty cache report 1000000000.

`count` must be a `number`, and `Number()` is deliberately **not** used to
coerce: it would turn `null` into 0, `true` into 1 and `'3'` into 3, so
`evict(null)` would silently do nothing and `evict(true)` would silently evict
one. This is the same rule the TTL normaliser in this class already applies,
for the same reason — a typo in a count must not read as a deliberate value.

#### Parameters

##### count?

`number` = `1`

#### Returns

`number`

Entries removed.

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

***

### getOrFetch()

> **getOrFetch**(`key`, `factory?`, `options?`): `Promise`\<`any`\>

`getOrSetAsync` using the cache's `fetchMethod` when no per-call factory is
given.

The reason this exists rather than as a required argument: the row's shape
(`fetchMethod` on the instance) removes a function literal from **every**
call site, which is most of the cost of the async cache API in a hot path.
The per-call factory still wins, so one caller can override a cache-wide
default — a cache is often keyed by more than one kind of resource.

#### Parameters

##### key

`any`

##### factory?

`Function`

Overrides the cache's `fetchMethod`.

##### options?

`PowerCacheGetOrFetchOptions` = `{}`

Passed through to `getOrSetAsync`.

#### Returns

`Promise`\<`any`\>

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

###### staleWhileRevalidate?

`boolean` = `...`

If true, return an expired value immediately and refresh the cache in the background.

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

###### staleWhileRevalidate?

`boolean` = `...`

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

***

### getStats()

> **getStats**(): `object`

Alias for [stats](#stats).

See `guides/stats-naming.md` for why both spellings exist and why this
method is written out per class.

#### Returns

`object`

##### evictions

> **evictions**: `number`

##### expirations

> **expirations**: `number`

##### hits

> **hits**: `number`

##### misses

> **misses**: `number`

##### poolSize

> **poolSize**: `number`

##### refreshesSkipped

> **refreshesSkipped**: `number`

##### rejected

> **rejected**: `number`

##### rejectedAdmission

> **rejectedAdmission**: `number`

##### size

> **size**: `number`

##### staleServes

> **staleServes**: `number`

##### weight

> **weight**: `number`

##### weightErrors

> **weightErrors**: `number`

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

`ignoreExpiry` considers expired entries as present; `maxNodes` bounds how far
  the scan goes and `compareFn` replaces the default deep comparison.

###### compareFn?

(`arg0`, `arg1`) => `boolean`

###### ignoreExpiry?

`boolean`

###### maxNodes?

`number`

#### Returns

`boolean`

***

### invalidate()

> **invalidate**(`predicate`): `number`

Remove every entry the predicate selects, and return how many went.

The row that asked for this (`GAP-017`) also asked for
`entriesAscending()` / `entriesDescending()`. **Those are not added**, and
the reason is worth more than the two methods would be: `entries(order)`
already takes `'LRU'` and `'MRU'`, so an alias pair for the same two orders
is a second spelling of one decision, and a second spelling is a second
thing to document, to type, to test and to keep in sync. Every reference
implementation checked has them because it does **not** have an order
parameter — this one does, and the parameter is the whole capability.

The predicate is evaluated over a **snapshot** of the entries before any of
them is removed. Two reasons, and the second is the important one:

1. `entries()` documents that removing two *adjacent* entries in one
   iteration step can end its walk early, so driving removal off the public
   generator would silently drop matches. This walks the list directly
   instead, and the list is not being mutated while the predicate runs.
2. A predicate that throws leaves the cache **untouched**. Collecting first
   means a failure cannot leave half the entries gone, which is the one
   outcome a bulk-removal API must never produce — there is no way to undo
   it and no counter that would tell a caller which half survived.

#### Parameters

##### predicate

(`key`, `value`) => `boolean`

Return truthy to remove.

#### Returns

`number`

Entries removed.

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

`number` \| \{ `interval?`: `number`; `intervalMs?`: `number`; `maxCleanupPerTick?`: `number`; \}

Cleanup interval in ms, or an options object. Written as one type expression rather
  than a bare `{Object}` with nested `@param` tags: those tags are only valid when
  the parent is a bare object, so the earlier spelling had to be `{number|Object}`
  and every property read off it was an error. Spelling the shape out removes the
  reason the nested tags were dropped.

#### Returns

`void`

***

### stats()

> **stats**(): `object`

Return runtime statistics for the cache.

Two of these counters were unreachable until CACHE-011, and both are read
for opposite reasons. `rejectedAdmission` is the *policy working*: non-zero
under `admission: 'tinylfu'` is what makes a scan-resistant cache
scan-resistant, so a benchmark that reports zero rejections has measured
nothing and a monitoring dashboard that expects a non-zero floor after a
traffic shift should be told the filter stopped running.
`weightErrors` is the opposite — a swallowed failure. `weightFn` threw, the
throw was routed to `onError` if one exists, and the entry was skipped; a
cache silently under-weighting itself will evict too much, or too little, and
nothing else in this object moves when it does.

Both were private fields with tests reading them directly, which is the tell
that they were meant to be public: `PowerCache` publishes the rest of its
counters here and lets `attach()` flatten them into metric series, so a
field missing from `stats()` is a field no collector can ever see.

#### Returns

`object`

##### evictions

> **evictions**: `number`

##### expirations

> **expirations**: `number`

##### hits

> **hits**: `number`

##### misses

> **misses**: `number`

##### poolSize

> **poolSize**: `number`

##### refreshesSkipped

> **refreshesSkipped**: `number`

##### rejected

> **rejected**: `number`

##### rejectedAdmission

> **rejectedAdmission**: `number`

##### size

> **size**: `number`

##### staleServes

> **staleServes**: `number`

##### weight

> **weight**: `number`

##### weightErrors

> **weightErrors**: `number`

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
