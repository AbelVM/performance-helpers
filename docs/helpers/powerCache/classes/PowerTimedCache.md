[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerCache](../README.md) / PowerTimedCache

# Class: PowerTimedCache

PowerTimedCache

A thin convenience wrapper around `PowerCache` for the common pure-TTL
use-case. It constructs an internal `PowerCache` with the provided `ttl`
used as the cache `defaultTTL` and automatically starts the periodic
cleanup loop. The wrapper delegates common cache methods to the
underlying `PowerCache` instance.

## Example

```ts
const timed = new PowerTimedCache(60000, { maxEntries: 100, interval: 10000 });
timed.set('k', 1);
// entries will be automatically expired by the background cleaner

@class PowerTimedCache
@public
```

## Constructors

### Constructor

> **new PowerTimedCache**(`ttl`, `options?`): `PowerTimedCache`

#### Parameters

##### ttl

`number`

Default TTL in milliseconds for entries.

##### options?

`PowerTimedCacheOptions` = `{}`

#### Returns

`PowerTimedCache`

## Properties

### cache

> **cache**: [`PowerCache`](PowerCache.md)

## Accessors

### hitRate

#### Get Signature

> **get** **hitRate**(): `number`

##### Returns

`number`

***

### size

#### Get Signature

> **get** **size**(): `number`

##### Returns

`number`

## Methods

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

***

### clear()

> **clear**(): `void`

#### Returns

`void`

***

### delete()

> **delete**(`key`): `boolean`

#### Parameters

##### key

`any`

#### Returns

`boolean`

***

### dispose()

> **dispose**(): `void`

Named alias for the `Symbol.dispose` implementation, so callers who
do not want to reach for the symbol still have something to call.

#### Returns

`void`

***

### entries()

> **entries**(`order?`): `IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

#### Parameters

##### order?

`"LRU"` \| `"MRU"`

Iteration order, forwarded verbatim to
  the inner `PowerCache`. Declared here rather than left implicit because an
  undeclared parameter is published as an implicit `any`, which accepts a
  typo like `'lru'` that the inner method would then reject at runtime.

#### Returns

`IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

***

### get()

> **get**(`key`): `any`

#### Parameters

##### key

`any`

#### Returns

`any`

***

### getMany()

> **getMany**(`keys`, `options?`): `Map`\<`string`, `any`\>

Read many keys in one pass. **Misses and expired entries are omitted**, not
returned as `undefined` — the inner loop does `if (!node) continue` — so the
result is smaller than the input and its keys are the resolved ones, in input
order. Use `has()` per key if you need to align positions.

#### Parameters

##### keys

`Iterable`\<`any`, `any`, `any`\>

##### options?

###### ignoreExpiry?

`boolean` = `false`

#### Returns

`Map`\<`string`, `any`\>

The resolved entries, in input order.

***

### getOrSet()

> **getOrSet**(`key`, `factory`, `options?`): `any`

Read through to a factory on a miss. The common idiom, and previously absent
here — so a TTL cache could not do the one thing callers reach a cache for.

#### Parameters

##### key

`any`

##### factory

`any`

A function producing the value, or the value itself.

##### options?

###### staleWhileRevalidate?

`boolean`

Return an expired value
  immediately and refresh in the background.

###### ttl?

`number`

Ignored when this instance has a constructor TTL.

###### weight?

`number`

#### Returns

`any`

***

### getOrSetAsync()

> **getOrSetAsync**(`key`, `asyncFactory`, `options?`): `Promise`\<`any`\>

`getOrSet` with an async factory. See the `PowerCache` guide for the
single-flight and `defaultAsyncTimeout` semantics.

#### Parameters

##### key

`any`

##### asyncFactory

`Function`

Returns a promise, or a value.

##### options?

###### staleWhileRevalidate?

`boolean`

###### timeout?

`number`

Per-call override of `defaultAsyncTimeout`.

###### ttl?

`number`

Ignored when this instance has a constructor TTL.

###### weight?

`number`

#### Returns

`Promise`\<`any`\>

***

### getStats()

> **getStats**(): `object`

Alias for [stats](#stats), so a caller who learned `getStats()` from
`PowerPool` — the one class that has always spelled it this way — is not
handed `TypeError: x.getStats is not a function` here.

Nine helpers spell the reporting method `stats()` and `PowerPool` spelled it
`getStats()`, with no stated rule and nothing pinning it, which reached the
documentation as a false claim (`guides/metrics.md`, `llm.txt`). Both
spellings work everywhere now. `stats()` is canonical and this delegates to
it; `PowerPool` keeps `getStats` because renaming the largest surface in the
library would be a breaking change.

Written out per class rather than installed on the prototype on purpose: a
dynamic `Object.defineProperty` is invisible to `tsc`, so the generated
`types/` omitted it and a TypeScript caller got a type error on a method
that worked at runtime. That was the first implementation.

**No `@returns` tag, and that is load-bearing.** The first version carried a
hand-copied copy of the `stats()` return shape, on the reasoning that an
explicit type was safer. It is not: the copy went stale the moment a
concurrent change added `staleServes` and `expirations` to `PowerCache`
`.stats()`, and `test/statsNaming.test.js` failed. Inference gives a
byte-identical published type and cannot drift, because there is nothing to
keep in sync. `test/types.test-d.ts` asserts the two are mutually assignable,
which is the property a consumer relies on.

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

#### Parameters

##### key

`any`

##### options?

`allowStale`
  returns an expired entry and refreshes in the background, bounded by
  `staleTtl` — see the `PowerCache` guide, because an unbounded stale window
  serves a value of any age.

###### allowStale?

`boolean`

###### staleTtl?

`number`

#### Returns

`boolean`

***

### hasEqual()

> **hasEqual**(`key`, `value`, `options?`): `boolean`

Test a value by **deep** comparison without promoting the entry to
most-recently-used. Not a reference test: after the reference and primitive
fast paths it falls through to a `deepEqual` walk, so a stored `{deep: 1}` does
match an incoming `{deep: 1}`. `compareFn` and `maxNodes` bound the walk.

The one quirk worth naming, because it is inherited by being the same code
rather than reimplemented: it does **not** touch recency, so a `hasEqual` sweep
leaves the eviction order untouched.

#### Parameters

##### key

`any`

##### value

`any`

##### options?

###### compareFn?

(`arg0`, `arg1`) => `boolean`

###### ignoreExpiry?

`boolean`

###### maxNodes?

`number`

#### Returns

`boolean`

***

### keys()

> **keys**(`order?`): `IterableIterator`\<`any`, `any`, `any`\>

#### Parameters

##### order?

`"LRU"` \| `"MRU"`

#### Returns

`IterableIterator`\<`any`, `any`, `any`\>

***

### peek()

> **peek**(`key`): `any`

Read a value **without** promoting it to most-recently-used, and without
counting a hit. For when the value matters but the access pattern does not.

#### Parameters

##### key

`any`

#### Returns

`any`

***

### resize()

> **resize**(`options?`): `void`

Change the capacity of a live cache. Takes effect on the next insertion.

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

> **set**(`key`, `value`, `options?`): `false` \| `PowerTimedCache`

#### Parameters

##### key

`any`

##### value

`any`

##### options?

Per-entry TTL in ms and
  weight. Both are ignored when this instance was constructed with a
  non-null TTL — the constructor's TTL wins.

###### ttl?

`number`

###### weight?

`number`

#### Returns

`false` \| `PowerTimedCache`

***

### setMany()

> **setMany**(`entries`, `options?`): `PowerTimedCache`

Insert many entries in one pass.

#### Parameters

##### entries

`Iterable`\<\[`any`, `any`\], `any`, `any`\>

##### options?

###### ttl?

`number` = `undefined`

Ignored when this instance has a constructor TTL.

###### weight?

`number` = `undefined`

#### Returns

`PowerTimedCache`

`this`, so a batch insert can be chained — **not** the
  inner `PowerCache`, which is what CACHE-013 had to correct in `set()`.

***

### startCleanup()

> **startCleanup**(`intervalOrOptions?`): `void`

#### Parameters

##### intervalOrOptions?

`undefined` = `undefined`

#### Returns

`void`

***

### stats()

> **stats**(): `object`

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

#### Returns

`void`

***

### touch()

> **touch**(`key`, `ttl?`): `boolean`

Extend (or shorten) one entry's TTL without reading or writing its value.

#### Parameters

##### key

`any`

##### ttl?

`number` = `undefined`

Per-call TTL in ms. `null`/`Infinity` disables expiry.

#### Returns

`boolean`

True if the entry existed and had not expired.

***

### values()

> **values**(`order?`): `IterableIterator`\<`any`, `any`, `any`\>

#### Parameters

##### order?

`"LRU"` \| `"MRU"`

#### Returns

`IterableIterator`\<`any`, `any`, `any`\>
