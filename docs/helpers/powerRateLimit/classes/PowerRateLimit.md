[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerRateLimit](../README.md) / PowerRateLimit

# Class: PowerRateLimit

PowerRateLimit — compose multiple limiters (tryConsume succeeds only when all
underlying limiters allow consumption).

Example:
const limit = new PowerRateLimit([
  new PowerThrottle({ capacity: 100, refillRate: 10 }),
  new PowerSlidingWindow({ capacity: 1000, windowMs: 60000 }),
]);
if (limit.tryConsume()) { /* perform work * / }

## Constructors

### Constructor

> **new PowerRateLimit**(`limiters?`, `options?`): `PowerRateLimit`

#### Parameters

##### limiters?

`Object`[] = `[]`

Array of limiter instances implementing
  `tryConsume(n)` and preferably `available()`.

##### options?

###### atomic?

`boolean`

When `true` attempt to provide
  atomic semantics: either all limiters allow consumption or none will be
  left mutated. This requires underlying limiters to expose `available()`
  or an undo primitive (e.g. `reserve`/`release` or `addTokens`). If a
  safe rollback cannot be guaranteed the call will return `false`.

#### Returns

`PowerRateLimit`

## Properties

### atomicDefault

> **atomicDefault**: `boolean`

***

### limiters

> **limiters**: `Object`[]

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

***

### reset()

> **reset**(): `void`

Reset all underlying limiters where supported.

#### Returns

`void`

***

### tryConsume()

> **tryConsume**(`n?`, `options?`): `boolean`

Try to consume `n` tokens across all limiters. Returns true only when
every underlying limiter allows consumption. This method first performs
a non-mutating availability check when `available()` is present; if all
checks pass it then performs the actual `tryConsume` calls to commit.

Note: when a limiter does not implement `available()` this method falls
back to calling `tryConsume` directly which may partially mutate state
if other limiters subsequently fail. Prefer limiters that implement
`available()` for atomic semantics.

#### Parameters

##### n?

`number` = `1`

##### options?

#### Returns

`boolean`
