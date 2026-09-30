[**performance-helpers**](../../../README.md)

---

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

---

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

---

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

---

### clear()

> **clear**(): `void`

#### Returns

`void`

---

### delete()

> **delete**(`key`): `boolean`

#### Parameters

##### key

`any`

#### Returns

`boolean`

---

### dispose()

> **dispose**(): `void`

Named alias for the `Symbol.dispose` implementation, so callers who
do not want to reach for the symbol still have something to call.

#### Returns

`void`

---

### entries()

> **entries**(`order`): `IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

#### Parameters

##### order

`any`

#### Returns

`IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

---

### get()

> **get**(`key`): `any`

#### Parameters

##### key

`any`

#### Returns

`any`

---

### has()

> **has**(`key`, `options?`): `boolean`

#### Parameters

##### key

`any`

##### options?

#### Returns

`boolean`

---

### keys()

> **keys**(`order`): `Generator`\<`any`, `void`, `unknown`\>

#### Parameters

##### order

`any`

#### Returns

`Generator`\<`any`, `void`, `unknown`\>

---

### set()

> **set**(`key`, `value`, `options?`): `false` \| [`PowerCache`](PowerCache.md)

#### Parameters

##### key

`any`

##### value

`any`

##### options?

#### Returns

`false` \| [`PowerCache`](PowerCache.md)

---

### startCleanup()

> **startCleanup**(`intervalOrOptions?`): `void`

#### Parameters

##### intervalOrOptions?

`undefined` = `undefined`

#### Returns

`void`

---

### stats()

> **stats**(): `object`

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

#### Returns

`void`

---

### values()

> **values**(`order`): `Generator`\<`any`, `void`, `unknown`\>

#### Parameters

##### order

`any`

#### Returns

`Generator`\<`any`, `void`, `unknown`\>
