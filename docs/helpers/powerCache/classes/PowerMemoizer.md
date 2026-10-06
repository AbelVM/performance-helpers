[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerCache](../README.md) / PowerMemoizer

# Class: PowerMemoizer

PowerMemoizer

A small memoization wrapper backed by `PowerCache`.
It memoizes synchronous values and Promise-returning functions.
Concurrent calls for the same arguments are deduplicated (single inflight Promise).
Rejected Promises are not cached.

Usage (constructor returns a `PowerMemoizer` instance; when a function is supplied
the instance creates a memoized wrapper and exposes a convenience `run()` alias):
const fetcher = async (id) => await fetchData(id)
const pm = new PowerMemoizer(fetcher, { cacheOptions: { defaultTTL: 1000 } })
// call the memoized function via the convenience alias
await pm.run(1)

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

`PowerMemoizerOptions` = `{}`

#### Returns

`PowerMemoizer`

## Properties

### \_defaultMemoizeOptions

> **\_defaultMemoizeOptions**: `object`

#### ttl?

> `optional` **ttl?**: `number`

#### weight?

> `optional` **weight?**: `number`

***

### \_fnWrapper

> **\_fnWrapper**: `MemoizedFunction`\<`Function`\> \| `undefined`

***

### \_inflight

> **\_inflight**: `Map`\<`any`, `any`\>

***

### \_nextReceiverId

> **\_nextReceiverId**: `number`

***

### \_originalFn

> **\_originalFn**: `Function` \| `null`

***

### \_receiverIds

> **\_receiverIds**: `WeakMap`\<`WeakKey`, `any`\>

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

> **run**: (...`args`) => `any`

#### Parameters

##### args

...`any`[]

#### Returns

`any`

## Methods

### \[dispose\]()

> **\[dispose\]**(): `void`

Release the underlying cache.

`PowerMemoizer` owns no state of its own - it delegates to a `PowerCache`
- so disposal forwards to it. The inner cache is not replaced, so a
disposed memoizer's `cache` reference stays readable.

#### Returns

`void`

***

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

### dispose()

> **dispose**(): `void`

Named alias for the `Symbol.dispose` implementation, so callers who do not
want to reach for the symbol still have something to call.

#### Returns

`void`

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

### getStats()

> **getStats**(): `Object`

Alias for [stats](#stats).

See `guides/stats-naming.md` for why both spellings exist and why this
method is written out per class.

#### Returns

`Object`

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

> **memoize**\<`F`\>(`fn`, `options?`): `MemoizedFunction`\<`F`\>

Public API to memoize an arbitrary function using this PowerMemoizer instance's cache.
Mirrors the behavior used by the constructor when a function is supplied —
returns a callable memoized function with helpers attached (`get`, `has`, `delete`, `clear`, `stats`, `cache`).

#### Type Parameters

##### F

`F` *extends* `Function`

#### Parameters

##### fn

`F`

Function to memoize

##### options?

`Object` = `{}`

Optional per-wrapper options { ttl, weight }

#### Returns

`MemoizedFunction`\<`F`\>

The memoized
  wrapper, callable like `fn` and
  carrying `get`/`has`/`delete`/`clear`/`stats`/`cache`/`original`.

***

### stats()

> **stats**(): `Object`

Expose underlying cache stats.

#### Returns

`Object`
