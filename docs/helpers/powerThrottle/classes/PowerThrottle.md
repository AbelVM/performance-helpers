[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerThrottle](../README.md) / PowerThrottle

# Class: PowerThrottle

## Constructors

### Constructor

> **new PowerThrottle**(`options?`): `PowerThrottle`

#### Parameters

##### options?

###### capacity?

`number`

###### refillInterval?

`number`

###### refillRate?

`number`

###### tokens?

`number`

#### Returns

`PowerThrottle`

## Properties

### \_lastRefill

> **\_lastRefill**: `number`

***

### \_tokenRemainder

> **\_tokenRemainder**: `number`

***

### capacity

> **capacity**: `number`

***

### refillInterval

> **refillInterval**: `number`

***

### refillRate

> **refillRate**: `number`

***

### tokens

> **tokens**: `number`

## Methods

### addTokens()

> **addTokens**(`n`): `void`

Add tokens to the bucket (forceful, useful for tests).

#### Parameters

##### n

`number`

#### Returns

`void`

***

### available()

> **available**(): `number`

Current available tokens (performs a refill before reporting).

#### Returns

`number`

***

### release()

> **release**(`tokenOrN`): `void`

Release a prior reservation token or add tokens back.
Accepts either a token returned from `reserve()` or a numeric count.

#### Parameters

##### tokenOrN

`number` \| `object`

#### Returns

`void`

#### Example

```ts
const token = throttle.reserve(2);
if (token) throttle.release(token);
throttle.release(1); // add one token back directly
```

***

### reserve()

> **reserve**(`n?`): \{ `n`: `number`; \} \| `null`

Reserve `n` tokens without committing them permanently. If successful,
returns a token object such as `{ n: 1 }` that may later be passed to
`release()` or `rollback()` to return the reserved tokens.

Returns `null` when the reservation fails due to insufficient tokens.

#### Parameters

##### n?

`number` = `1`

#### Returns

\{ `n`: `number`; \} \| `null`

#### Example

```ts
const token = throttle.reserve(1);
if (token) {
  // use reserved slot
  throttle.release(token);
}
```

***

### reset()

> **reset**(`count?`): `void`

Reset the bucket to a given token count (or full when omitted).

#### Parameters

##### count?

`number`

#### Returns

`void`

***

### rollback()

> **rollback**(`nOrToken`): `void`

#### Parameters

##### nOrToken

`any`

#### Returns

`void`

***

### tryConsume()

> **tryConsume**(`n?`): `boolean`

Try to consume `n` tokens.

#### Parameters

##### n?

`number` = `1`

#### Returns

`boolean`

`true` when tokens were consumed; `false` otherwise.
