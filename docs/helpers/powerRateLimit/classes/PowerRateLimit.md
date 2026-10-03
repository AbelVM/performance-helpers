[**performance-helpers**](../../../README.md)

***

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

### \_slots

> **\_slots**: (`RateLimiterLike`[] \| `null`)[]

***

### atomicDefault

> **atomicDefault**: `boolean`

***

### buckets

> **buckets**: `number`

***

### keyFn

> **keyFn**: ((`arg0`) => `string`) \| `null`

***

### limiters

> **limiters**: `RateLimiterLike`[]

## Methods

### \_undoCommit()

> **\_undoCommit**(`entry`, `want`): `Promise`\<`void`\>

#### Parameters

##### entry

###### l

`RateLimiterLike`

###### method

`string`

###### token?

`any`

##### want

`number`

#### Returns

`Promise`\<`void`\>

***

### available()

> **available**(`options?`): `number`

Return the minimum available tokens across all limiters.
If any limiter does not expose `available()`, this returns `0`.
With `keyFn`, `options.context` selects the key whose slot is measured —
without it the result is the shared default slot's.

#### Parameters

##### options?

`PowerRateLimitCallOptions` = `{}`

#### Returns

`number`

***

### limitersFor()

> **limitersFor**(`key`): `RateLimiterLike`[] \| `null`

The per-key limiter set for `key`, for a caller that wants to inspect or
drive one key directly (a `retryAfter` in a `Retry-After` header, say).

#### Parameters

##### key

`string`

#### Returns

`RateLimiterLike`[] \| `null`

`null` when no `keyFn` is configured.

***

### release()

> **release**(`tokenOrN`, `options?`): `void`

Release a prior reservation token or numeric count back to the limiters.
This accepts the same token object produced by `reserve()` or a numeric
count to return tokens directly.

Deliberately still coercing rather than calling `assertCount`, because this
is the *return* path and not the admission path. A count that cannot be
read returns nothing, which is the safe direction: admitting a request you
cannot price is how a limiter is bypassed, whereas returning nothing merely
over-charges the caller.

**What a leg's `release` actually receives, which is a contract and not an
implementation detail.** There are two undo paths in this class and they hand
a leg different objects, deliberately:

- **This one** passes the caller's `tokenOrN` through unchanged, so a leg
  that implements `reserve` receives the **composer's** token — `{ n }` — not
  the object the leg itself minted. The token is public API and two tests in
  `powerRateLimit.extra.test.js` pin that shape, so it is not changing.
- **`_undoCommit`** — the rollback taken when a later leg fails — passes the
  **leg's own** token, because it has it in hand and the leg is the only thing
  that could have minted it.

A leg whose `release` only reads `.n` (as `PowerThrottle`'s does) cannot tell
the difference. **A leg that looks its token up in a `Map` it minted it into
can, and will miss.** So the requirement on a limiter used here is that its
`release` accepts either shape — a `{ n }`-bearing object *or* a plain count —
which is exactly what `PowerThrottle.release` already does. Where a leg's
`release` throws on an unrecognised token, the fallback below reaches
`rollback`/`addTokens` with the count instead, so the credit is not simply
lost.

#### Parameters

##### tokenOrN

`number` \| `object`

##### options?

`PowerRateLimitCallOptions` = `{}`

**With `keyFn`, `options.key`
  selects the slot to refund** — the same per-call convention `tryConsume` and
  `available()` already use. Without it a keyed composer credits **every
  built slot**, which is what this parameter exists to stop (RES-039):
  `reserve()`/`tryConsume` debit one slot, so a slot-wide refund hands a tenant
  an allowance it never spent away, and because `PowerThrottle.release` clamps
  at `capacity` the victim ends up *fully* topped up rather than merely
  nudged. Reproduced at capacity 5: tenant A spends 4, tenant B spends 1, and
  `release(4)` left both at 5.

  Omitting `key` is not "refund everything" — it routes to the same shared
  slot that `tryConsume` without a key debits, which is the honest degradation
  and the one `_slotFor` already documents.

  Note this is deliberately **not** solved by putting a `slot` field on the
  token: the token is public API, `toEqual({ n: 1 })` is pinned by a test, and
  `limitersFor(key)` already exposes the slot. A per-call argument matches the
  rest of the class and changes nothing a caller can already observe.

#### Returns

`void`

***

### reserve()

> **reserve**(`n?`, `options?`): \{ `n`: `number`; \} \| `null`

Reserve `n` tokens across all limiters and return a token to undo later.
Returns `null` when reservation fails.
The returned token is a simple marker object such as `{ n: 1 }`, and it can
be consumed by `release(token)` or `rollback(token)` to restore the limiters.

#### Parameters

##### n?

`number` = `1`

##### options?

`PowerRateLimitCallOptions` = `{}`

Per-call overrides; `context`
  selects the `keyFn` slot, so a reservation is made against the same
  budget the caller's own `tryConsume` will spend.

#### Returns

\{ `n`: `number`; \} \| `null`

***

### reset()

> **reset**(): `void`

Reset all underlying limiters where supported.

With `keyFn`, every **built** slot is reset rather than the factory list:
the factories are not limiters and resetting them would rebuild nothing.
Built slots stay built, because discarding them would hand every tenant a
fresh allowance — the eviction-is-a-reset bypass this design exists to avoid.

#### Returns

`void`

***

### rollback()

> **rollback**(`nOrToken?`): `void` \| `Promise`\<`void`\>

#### Parameters

##### nOrToken?

`number` \| \{ `n?`: `number`; \}

Same argument shape as `release`.

#### Returns

`void` \| `Promise`\<`void`\>

***

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

`PowerRateLimitCallOptions` = `{}`

Per-call overrides; `atomic`
  defaults to the instance setting, `now` supplies the single clock reading
  threaded into every leg, and `context` is what `keyFn` is called with.

#### Returns

`boolean`

`true` only when every composed limiter allowed it.
