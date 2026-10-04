[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerTTLMap](../README.md) / PowerTTLMap

# Class: PowerTTLMap

PowerTTLMap

Lightweight Map-like store where each key has an optional TTL (milliseconds).
Entries expire lazily on access or iteration.

 PowerTTLMap

## Constructors

### Constructor

> **new PowerTTLMap**(`defaultTTL?`, `options?`): `PowerTTLMap`

#### Parameters

##### defaultTTL?

`number` \| `PowerTTLMapOptions`

Default TTL in milliseconds for keys set
  without explicit ttl (0 = no expiry). Accepts either a positional number or an options
  object `{ defaultTTL, onExpire }` for consistency with the other helpers.

##### options?

`PowerTTLMapOptions` = `{}`

Options object (used when the first arg is a number).

#### Returns

`PowerTTLMap`

## Properties

### \_defaultTTL

> **\_defaultTTL**: `number`

***

### \_disposed

> **\_disposed**: `boolean`

***

### \_expirations

> **\_expirations**: `Map`\<`any`, `number`\>

***

### \_map

> **\_map**: `Map`\<`any`, `TTLMapEntry`\>

***

### \_nextExpiryAt

> **\_nextExpiryAt**: `number`

***

### \_nextExpiryDirty

> **\_nextExpiryDirty**: `boolean`

***

### \_now

> **\_now**: () => `number`

Get a high-resolution timestamp in milliseconds since the epoch.

This function prefers `performance.timeOrigin + performance.now()` when
available and reasonably close to `Date.now()` to provide higher
resolution timestamps. On Node.js it uses `process.hrtime.bigint()` with an
epoch offset when available. Falls back to `Date.now()` if nothing
better is available or when offsets appear to diverge (e.g. in some
test harnesses).

#### Returns

`number`

Milliseconds since epoch (floating point for higher resolution).

***

### \_onExpire

> **\_onExpire**: ((`key`, `value`) => `void`) \| `null`

## Accessors

### expiredCount

#### Get Signature

> **get** **expiredCount**(): `number`

How many resident entries are past their expiry and awaiting collection.

The live count is `size - expiredCount`. Read-only: this does not sweep and
does not fire `onExpire`, so it is safe to use as a diagnostic without
changing the map. It does walk the expiration index, so it is O(k) in the
number of entries that *have* an expiry — which is why the hot path reads
[PowerTTLMap#size](#size) and this is for reporting.

##### Returns

`number`

***

### size

#### Get Signature

> **get** **size**(): `number`

Number of entries currently resident in the map.

**This is `Map.size`, not "how many entries are still live".** The two
used to be the same getter, and that was a design smell: reading `.size`
called `_sweepExpirations`, which iterates the expiration index, removes
entries, and fires `onExpire` for each. A property read with a callback
side effect is not a property read — it is an operation wearing a
property's syntax, so `if (map.size)` was a mutation, a `size` check in a
render loop was O(k) per frame, and the cost of the answer was invisible
at the call site.

Expired-but-not-yet-swept entries are resident and are therefore counted.
That is the honest meaning of the number, it is O(1), and it is what
`Map` users expect. Use [PowerTTLMap#expiredCount](#expiredcount) when you want the
live count, or [PowerTTLMap#purge](#purge) to actually collect.

##### Returns

`number`

## Methods

### \_checkExpire()

> **\_checkExpire**(`key`, `entry?`): `boolean`

Whether a key needs removing: absent, or present and past its expiry.

#### Parameters

##### key

`any`

##### entry?

`TTLMapEntry`

#### Returns

`boolean`

***

### \_sweepExpirations()

> **\_sweepExpirations**(`now`): `void`

Drop every expired entry the expiration index knows about, then recompute
the soonest remaining expiry.

#### Parameters

##### now

`number`

#### Returns

`void`

***

### \_updateNextExpiryOnWrite()

> **\_updateNextExpiryOnWrite**(`prevExpiry`, `nextExpiry`): `void`

Keep `_nextExpiryAt` pointing at the soonest live expiry, invalidating the
cached `size` shortcut when the entry that held it is gone or replaced.

#### Parameters

##### prevExpiry

`number`

The key's expiry before this write, `0` if none.

##### nextExpiry

`number`

The key's expiry after this write, `0` if none.

#### Returns

`void`

***

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [dispose](#dispose-1), so `using x = new X()` releases the instance
deterministically at scope exit.

#### Returns

`void`

***

### \[iterator\]()

> **\[iterator\]**(): `IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

Default iterator yielding `[key, value]` pairs for non-expired entries.

#### Returns

`IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

***

### clear()

> **clear**(): `void`

#### Returns

`void`

***

### delete()

> **delete**(`key`): `boolean`

Delete a key.

#### Parameters

##### key

`any`

#### Returns

`boolean`

***

### dispose()

> **dispose**(): `void`

Release every resource this instance holds.

Idempotent, and safe to call while the instance is idle. Exists so the
instance works with `using` / `await using` and gives callers an explicit
name to call.

**Afterwards the map is inert rather than reusable: `set()` throws.** That is
the fix in CACHE-014, and it is a deliberate choice against the alternative of
leaving the instance writable. `dispose()` neutralises `clear()` so a second
call is a no-op, so an instance that still accepted writes would hold entries
the caller had no way to remove. Reads keep working and report an empty map.

#### Returns

`void`

***

### entries()

> **entries**(): `IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

Iterate entries [key, value] skipping expired entries.

Expired entries encountered during the walk are **collected** as a side
effect, firing `onExpire`. That is deliberate and is a different situation
from [PowerTTLMap#size](#size): iteration is an operation, so a caller can
see it happen, whereas a property read cannot.

#### Returns

`IterableIterator`\<\[`any`, `any`\], `any`, `any`\>

***

### forEach()

> **forEach**(`cb`, `thisArg?`): `void`

Call `cb` for each non-expired entry.

#### Parameters

##### cb

(`value`, `key`, `map`) => `void`

##### thisArg?

`any`

#### Returns

`void`

***

### get()

> **get**(`key`): `any`

Get a value, returning `undefined` when missing or expired.

#### Parameters

##### key

`any`

#### Returns

`any`

***

### has()

> **has**(`key`): `boolean`

Check whether a key exists and is not expired.

#### Parameters

##### key

`any`

#### Returns

`boolean`

***

### keys()

> **keys**(): `IterableIterator`\<`any`, `any`, `any`\>

Iterate keys of non-expired entries.

#### Returns

`IterableIterator`\<`any`, `any`, `any`\>

***

### purge()

> **purge**(): `number`

Collect every entry that is already past its expiry, firing `onExpire` for
each.

The explicit spelling of what `size` used to do implicitly. Reads and
`expiredCount` are pure; collection is opt-in.

#### Returns

`number`

How many entries were removed.

***

### reset()

> **reset**(): `void`

Alias for [PowerTTLMap#clear](#clear).

`clear()` here empties the container, and "reset" is a natural second word
for exactly that - so a caller who reaches for `reset()` on this class gets
the obvious thing instead of a `TypeError`. No limiter gets this alias: for
`PowerThrottle` and `PowerPermitGate`, `reset()` *refills* and `clear()`
would read as the opposite, and the two are deliberately not synonyms.

#### Returns

`void`

***

### set()

> **set**(`key`, `value`, `ttl?`): `PowerTTLMap`

Set a key with optional TTL (ms).

#### Parameters

##### key

`any`

##### value

`any`

##### ttl?

`number` \| \{ `ttl?`: `number`; \}

TTL in milliseconds for this key. Accepts either a
  positional number or an options object `{ ttl }` for consistency with `PowerCache.set`.

#### Returns

`PowerTTLMap`

***

### touch()

> **touch**(`key`, `ttl?`): `boolean`

Refresh TTL for an existing key. No-op if missing/expired.

#### Parameters

##### key

`any`

##### ttl?

`number` \| \{ `ttl?`: `number`; \}

#### Returns

`boolean`

True when TTL refreshed.

***

### values()

> **values**(): `IterableIterator`\<`any`, `any`, `any`\>

Iterate values of non-expired entries.

#### Returns

`IterableIterator`\<`any`, `any`, `any`\>
