[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/metrics](../README.md) / attach

# Function: attach()

> **attach**(`instance`, `name`, `options?`): \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

Wire a helper's `stats()` into a collector, and hand back the receipt that
undoes it.

The receipt is not optional bookkeeping. A collector holds a closure over the
instance, so a disposed pool that is never unregistered is sampled forever -
and after `terminate()` its `getStats()` still answers, so nothing fails
visibly while the series quietly reports a dead object. Passing the receipt
to [detach](detach.md) on teardown is what makes the two halves agree.

## Parameters

### instance

`Object`

The helper being registered.

### name

`string`

Series prefix. Use a discriminator when more than one
  of the same helper is in one process, e.g. `cache.images`.

### options?

The helper's own options object.

#### observability?

`boolean` \| [`MetricsCollector`](../classes/MetricsCollector.md)

`true` for the
  shared collector, or a collector to register with. Anything else — the
  default `false`, a bad value — registers nothing and costs nothing.

## Returns

\{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

The receipt,
  or `null` when the helper is not observable. The receipt carries a bound
  `unregister` rather than the collector, which is what lets every helper's
  `_metrics` field stay a plain object type in the published declarations —
  a bare class name here would be emitted into nine `.d.ts` files with no
  import to resolve it against.

## Example

```ts
const cache = new PowerCache({ observability: true });
defaultMetrics.snapshot().series; // { 'cache.size': 0, ... }
```
