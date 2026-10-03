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

##### size

> **size**: `number`

##### staleServes

> **staleServes**: `number`

##### weight

> **weight**: `number`

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

### keys()

> **keys**(`order?`): `IterableIterator`\<`any`, `any`, `any`\>

#### Parameters

##### order?

`"LRU"` \| `"MRU"`

#### Returns

`IterableIterator`\<`any`, `any`, `any`\>

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

##### size

> **size**: `number`

##### staleServes

> **staleServes**: `number`

##### weight

> **weight**: `number`

***

### stopCleanup()

> **stopCleanup**(): `void`

#### Returns

`void`

***

### values()

> **values**(`order?`): `IterableIterator`\<`any`, `any`, `any`\>

#### Parameters

##### order?

`"LRU"` \| `"MRU"`

#### Returns

`IterableIterator`\<`any`, `any`, `any`\>
