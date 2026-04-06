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
Accepts either a token returned from `reserve()` or a numeric value.

#### Parameters

##### tokenOrN

`number` \| `object`

#### Returns

`void`

***

### reserve()

> **reserve**(`n?`): `object` \| `null`

Reserve `n` tokens without committing them permanently. Returns a token
object that can be passed to `release()` to undo the reservation.
Returns `null` when reservation fails.

#### Parameters

##### n?

`number` = `1`

#### Returns

`object` \| `null`

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
