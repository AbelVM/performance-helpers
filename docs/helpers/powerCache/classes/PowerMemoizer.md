[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerCache](../README.md) / PowerMemoizer

# Class: PowerMemoizer

PowerMemoizer

A small memoization wrapper backed by `PowerCache`.
It memoizes synchronous values and Promise-returning functions.
Concurrent calls for the same arguments are deduplicated (single inflight Promise).
Rejected Promises are not cached.

Usage (constructor returns a callable memoized function when given `fn`):
const fetcher = async (id) => await fetchData(id)
const memoizedFetch = new PowerMemoizer(fetcher, { cacheOptions: { defaultTTL: 1000 } })
// call the memoized function directly
await memoizedFetch(1)

 PowerMemoizer

## Constructors

### Constructor

> **new PowerMemoizer**(`fn?`, `options?`): `PowerMemoizer`

Create a PowerMemoizer.

#### Parameters

##### fn?

`Function`

Optional function to memoize immediately.

##### options?

###### cacheOptions?

`Object`

Options forwarded to the underlying `PowerCache` constructor. Supported keys: `maxEntries` (number), `maxWeight` (number), `weightFn` (function(value):number), `defaultTTL` (number, ms), `maxPoolSize` (number), `rejectOversized` (boolean), `onEvict` (function(key, value, reason)), `onExpire` (function(key, value)), `initialPoolSize` (number), `maxCleanupPerTick` (number). See `PowerCache` constructor JSDoc for details.

###### keyResolver?

(`arg0`) => `string`

Function that maps the wrapped call args to a cache key. Defaults to `JSON.stringify` on args.
  Note: `JSON.stringify(args)` is convenient but can be expensive for large or deeply-nested
  arguments. If the wrapped function is on a hot path, provide a custom `keyResolver`
  that cheaply and deterministically maps arguments to keys (for example, join simple
  scalar args with a separator or use a fast hashing function).

###### ttl?

`number`

Default TTL (ms) used when constructing the memoized wrapper for `fn`.

###### weight?

`number`

Default weight used when constructing the memoized wrapper for `fn`.

#### Returns

`PowerMemoizer`

## Properties

### \_defaultMemoizeOptions

> **\_defaultMemoizeOptions**: `object`

***

### \_inflight

> **\_inflight**: `Map`\<`any`, `any`\>

***

### \_originalFn

> **\_originalFn**: `any`

***

### cache

> **cache**: [`PowerCache`](PowerCache.md)

***

### keyResolver

> **keyResolver**: (`arg0`) => `string`

#### Parameters

##### arg0

`any`[]

#### Returns

`string`

***

### run

> **run**: (() => `never`) \| `undefined`

## Methods

### clear()

> **clear**(): `void`

Clear all cached entries and any inflight markers.

#### Returns

`void`

***

### delete()

> **delete**(...`args`): `boolean`

Delete the cached entry for the given call args.
Also clears any inflight Promise for the key.

#### Parameters

##### args

...`any`[]

#### Returns

`boolean`

***

### get()

> **get**(...`args`): `any`

Retrieve a cached value for the given call args (if present).

#### Parameters

##### args

...`any`[]

#### Returns

`any`

***

### has()

> **has**(...`args`): `boolean`

Check presence for the given call args.

#### Parameters

##### args

...`any`[]

#### Returns

`boolean`

***

### memoize()

> **memoize**(`fn`, `options?`): `Function`

Public API to memoize an arbitrary function using this PowerMemoizer instance's cache.
Mirrors the behavior used by the constructor when a function is supplied —
returns a callable memoized function with helpers attached (`get`, `has`, `delete`, `clear`, `stats`, `cache`).

#### Parameters

##### fn

`Function`

Function to memoize

##### options?

`Object` = `{}`

Optional per-wrapper options { ttl, weight }

#### Returns

`Function`

Memoized function

***

### stats()

> **stats**(): `Object`

Expose underlying cache stats.

#### Returns

`Object`
