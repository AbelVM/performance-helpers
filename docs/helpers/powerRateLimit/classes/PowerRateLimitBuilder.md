[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerRateLimit](../README.md) / PowerRateLimitBuilder

# Class: PowerRateLimitBuilder

Fluent builder for [PowerRateLimit](PowerRateLimit.md). Allows ergonomic construction of
composed limiters without manually building the options object.

## Example

```ts
const limit = PowerRateLimit.builder()
  .add(new PowerThrottle({ capacity: 100, refillRate: 10 }))
  .add(new PowerSlidingWindow({ capacity: 1000, windowMs: 60000 }))
  .atomic(true)
  .build();
```

## Constructors

### Constructor

> **new PowerRateLimitBuilder**(): `PowerRateLimitBuilder`

#### Returns

`PowerRateLimitBuilder`

## Properties

### \_limiters

> **\_limiters**: `RateLimiterLike`[] = `[]`

***

### \_options

> **\_options**: `PowerRateLimitOptions` = `{}`

## Methods

### add()

> **add**(`limiter`): `PowerRateLimitBuilder`

Add a limiter to the composition.

#### Parameters

##### limiter

`RateLimiterLike`

#### Returns

`PowerRateLimitBuilder`

***

### atomic()

> **atomic**(`value`): `PowerRateLimitBuilder`

Set the `atomic` option. When true, all-or-nothing semantics are attempted.

#### Parameters

##### value

`boolean`

#### Returns

`PowerRateLimitBuilder`

***

### buckets()

> **buckets**(`value`): `PowerRateLimitBuilder`

Set the `buckets` option for the per-key slot array size.

#### Parameters

##### value

`number`

#### Returns

`PowerRateLimitBuilder`

***

### build()

> **build**(): [`PowerRateLimit`](PowerRateLimit.md)

Build the [PowerRateLimit](PowerRateLimit.md) instance.

#### Returns

[`PowerRateLimit`](PowerRateLimit.md)

***

### degrade()

> **degrade**(`value`): `PowerRateLimitBuilder`

Set the `degrade` mode for shared-state backend errors.

#### Parameters

##### value

`"local"` \| `"fail-closed"`

#### Returns

`PowerRateLimitBuilder`

***

### keyFn()

> **keyFn**(`value`): `PowerRateLimitBuilder`

Set the `keyFn` option for per-key limiting.

#### Parameters

##### value

((`ctx`) => `string`) \| `null`

#### Returns

`PowerRateLimitBuilder`

***

### sharedState()

> **sharedState**(`value`): `PowerRateLimitBuilder`

Set the `sharedState` adapter for distributed rate limiting.

#### Parameters

##### value

`PowerSharedStateAdapter` \| `null`

#### Returns

`PowerRateLimitBuilder`
