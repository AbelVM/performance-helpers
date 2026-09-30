[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/powerThrottle](../README.md) / PowerThrottle

# Class: PowerThrottle

## Constructors

### Constructor

> **new PowerThrottle**(`options?`): `PowerThrottle`

See PowerThrottleOptions for the accepted fields; every default is
stated there, because a bare `@param {Object} [options]` here is what let
the published type and the destructuring drift apart in the first place.

#### Parameters

##### options?

`PowerThrottleOptions` = `{}`

#### Returns

`PowerThrottle`

## Properties

### \_lastRefill

> **\_lastRefill**: `number`

---

### \_now

> **\_now**: () => `number`

Clock for this limiter, and whether it was explicitly injected. See
`resolveLimiterNow` for why the flag is load-bearing: an injected clock
must outrank a value threaded in by a composition.

#### Returns

`number`

---

### \_nowExplicit

> **\_nowExplicit**: `boolean`

---

### \_tokenRemainder

> **\_tokenRemainder**: `number`

---

### capacity

> **capacity**: `number`

---

### refillInterval

> **refillInterval**: `number`

---

### refillRate

> **refillRate**: `number`

---

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

---

### available()

> **available**(`options?`): `number`

Current available tokens (performs a refill before reporting).

#### Parameters

##### options?

#### Returns

`number`

---

### release()

> **release**(`tokenOrN`): `void`

Release a prior reservation token or add tokens back.
Accepts either a token returned from `reserve()` or a numeric count.

#### Parameters

##### tokenOrN

`number` \| `PowerThrottleToken`

#### Returns

`void`

#### Example

```ts
const token = throttle.reserve(2);
if (token) throttle.release(token);
throttle.release(1); // add one token back directly
```

---

### reserve()

> **reserve**(`n?`, `options?`): `PowerThrottleToken` \| `null`

Reserve `n` tokens without committing them permanently. If successful,
returns a token object such as `{ n: 1 }` that may later be passed to
`release()` or `rollback()` to return the reserved tokens.

Returns `null` when the reservation fails due to insufficient tokens.

#### Parameters

##### n?

`number` = `1`

##### options?

#### Returns

`PowerThrottleToken` \| `null`

#### Example

```ts
const token = throttle.reserve(1);
if (token) {
  // use reserved slot
  throttle.release(token);
}
```

---

### reset()

> **reset**(`count?`): `void`

Reset the bucket to a given token count (or full when omitted).

#### Parameters

##### count?

`number`

#### Returns

`void`

---

### rollback()

> **rollback**(`nOrToken`): `void`

Alias of [PowerThrottle#release](#release).

#### Parameters

##### nOrToken

`number` \| `PowerThrottleToken`

#### Returns

`void`

---

### tryConsume()

> **tryConsume**(`n?`, `options?`): `boolean`

Try to consume `n` tokens.

#### Parameters

##### n?

`number` = `1`

##### options?

#### Returns

`boolean`

`true` when tokens were consumed; `false` otherwise.
