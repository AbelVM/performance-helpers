[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/metrics](../README.md) / toSeries

# Function: toSeries()

> **toSeries**(`helper`, `stats`): `Record`\<`string`, `string` \| `number` \| `boolean` \| `null`\>

Flatten one helper's `stats()` into scalar series keys.

Nested objects are joined with a dot rather than dropped, so `size` and a
hypothetical `pooled.used` coexist without a naming scheme. Arrays are
**omitted** rather than joined: `getStats().status` is an array of per-worker
objects whose length means worker count and whose contents are the real
detail. Turning that into a string key would put an arbitrary, unbounded
number of series into the map, and joining it into one would hide the detail
the caller came for.

## Parameters

### helper

`string`

The helper name, used as the series prefix.

### stats

`any`

Whatever that helper's `stats()` returned.

## Returns

`Record`\<`string`, `string` \| `number` \| `boolean` \| `null`\>

Flat scalar series.

## Example

```ts
toSeries('cache', new PowerCache().stats());
// => { 'cache.size': 0, 'cache.hitRate': 0, 'cache.pool.size': 16, ... }
```
