[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/metrics](../README.md) / MetricsCollector

# Class: MetricsCollector

Collects point-in-time snapshots from one or more helpers.

A collector does not own the helpers. It is handed their `stats()` — however
often you choose, and a _reference_ rather than the instance, so a caller can
sample a pool every request and a cache every minute through the same
collector. Sampling is therefore the caller's decision, and the deliberate
design point is that **draining is explicit** rather than push-based: a
metrics sink that fires on every operation is a metrics sink that becomes a
performance problem, and a timer that does it for you is one you cannot turn
off.

## Example

```ts
const cache = new PowerCache();
const metrics = new MetricsCollector();

metrics.register('cache', () => cache.stats());
// ... later
const { version, series } = metrics.snapshot();
series['cache.hitRate']; // stable key, whatever cache.stats() is shaped like
```

## Constructors

### Constructor

> **new MetricsCollector**(`options?`): `MetricsCollector`

#### Parameters

##### options?

###### prefix?

`string`

Prepended to every series key, so two
collectors in one process do not collide.

#### Returns

`MetricsCollector`

## Properties

### \_prefix

> **\_prefix**: `string`

---

### \_sources

> **\_sources**: `Map`\<`string`, () => `any`\>

## Methods

### names()

> **names**(): `string`[]

The registered source names.

#### Returns

`string`[]

---

### register()

> **register**(`name`, `read`): `MetricsCollector`

Register a named source. The callback is called on each `snapshot()` and
should return that helper's `stats()`.

Re-registering a name replaces the previous source rather than adding a
second series for it, so a caller that re-registers on reconfigure does not
silently double-count.

#### Parameters

##### name

`string`

Series prefix for this source.

##### read

() => `any`

Returns the source's current stats.

#### Returns

`MetricsCollector`

---

### snapshot()

> **snapshot**(): `object`

Take a point-in-time snapshot of every registered source.

One source throwing does not lose the others. A metrics sink that goes
blank because one helper misbehaved is worse than one that reports
everything except the broken thing, so the failure is recorded under
`<name>.error` and the rest is still collected.

#### Returns

`object`

##### collectedAt

> **collectedAt**: `number`

##### errors

> **errors**: `Record`\<`string`, `string`\>

##### series

> **series**: `Record`\<`string`, `any`\>

##### sources

> **sources**: `string`[]

##### version

> **version**: `number`

---

### unregister()

> **unregister**(`name`): `boolean`

Stop reporting a source. The key disappears from the next snapshot rather
than reporting its last known value, which would be a lie: a number frozen
at deregistration looks exactly like a number that stopped moving.

#### Parameters

##### name

`string`

#### Returns

`boolean`

Whether a source was removed.
