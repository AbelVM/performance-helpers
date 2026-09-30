[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/powerRateLimit](../README.md) / PowerRateLimit

# Class: PowerRateLimit

PowerRateLimit

Compose multiple rate limiters and provide a unified `tryConsume`/`reserve` API.
Returns success only when all underlying limiters allow consumption.

PowerRateLimit

## Constructors

### Constructor

> **new PowerRateLimit**(`limiters?`, `options?`): `PowerRateLimit`

#### Parameters

##### limiters?

`RateLimiterLike`[] = `[]`

Limiter instances to compose. Each
must provide `tryConsume(n)`; `reserve`, `release`, `addTokens`,
`rollback` and `available` are used when present.

##### options?

`PowerRateLimitOptions` = `{}`

`atomic` attempts all-or-nothing
semantics: either every limiter allows the consumption or none is left
mutated. That requires each to expose `available()` or an undo primitive
(`reserve`/`release`, or `addTokens`). When a safe rollback cannot be
guaranteed the call returns `false`.

#### Returns

`PowerRateLimit`

## Properties

### atomicDefault

> **atomicDefault**: `boolean`

---

### limiters

> **limiters**: `RateLimiterLike`[]

## Methods

### \_undoCommit()

> **\_undoCommit**(`entry`, `want`): `Promise`\<`any`\>

#### Parameters

##### entry

`any`

##### want

`any`

#### Returns

`Promise`\<`any`\>

---

### available()

> **available**(`options?`): `number`

Return the minimum available tokens across all limiters.
If any limiter does not expose `available()`, this returns `0`.

#### Parameters

##### options?

#### Returns

`number`

---

### release()

> **release**(`tokenOrN`): `void`

Release a prior reservation token or numeric count back to the limiters.
This accepts the same token object produced by `reserve()` or a numeric
count to return tokens directly.

#### Parameters

##### tokenOrN

`number` \| `object`

#### Returns

`void`

---

### reserve()

> **reserve**(`n?`): \{ `n`: `number`; \} \| `null`

Reserve `n` tokens across all limiters and return a token to undo later.
Returns `null` when reservation fails.
The returned token is a simple marker object such as `{ n: 1 }`, and it can
be consumed by `release(token)` or `rollback(token)` to restore the limiters.

#### Parameters

##### n?

`number` = `1`

#### Returns

\{ `n`: `number`; \} \| `null`

---

### reset()

> **reset**(): `void`

Reset all underlying limiters where supported.

#### Returns

`void`

---

### rollback()

> **rollback**(`nOrToken`): `void`

#### Parameters

##### nOrToken

`any`

#### Returns

`void`

---

### tryConsume()

> **tryConsume**(`n?`, `options?`): `boolean`

Try to consume `n` tokens across all limiters. Returns true only when
every underlying limiter allows consumption. This method first performs a
best-effort availability pre-check using `available()` when present; if all
checks pass it then performs the actual `tryConsume` calls to commit.
Note: some limiters' `available()` also advances internal state (e.g.
`PowerThrottle` refills tokens, `PowerSlidingWindow` prunes expired
timestamps). The pre-check and the commit run synchronously within the
same tick, so results stay consistent — but `available()` is not strictly
read-only.

Note: when a limiter does not implement `available()` this method falls
back to calling `tryConsume` directly which may partially mutate state
if other limiters subsequently fail. Prefer limiters that implement
`available()` for atomic semantics.

#### Parameters

##### n?

`number` = `1`

Tokens to consume.

##### options?

`PowerRateLimitOptions` & `LimiterNowOptions` = `{}`

Per-call
overrides; `atomic` defaults to the instance setting, and `now` supplies
the single clock reading threaded into every leg.

#### Returns

`boolean`

`true` only when every composed limiter allowed it.
