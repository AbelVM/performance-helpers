# PowerTTLMap

A lightweight Map-like with per-key TTL (milliseconds). Keys expire lazily on access and iteration.

## Constructor

| Option       |           Type |     Default | Description                                                                                                                                                                                                                                                                                    |
| ------------ | -------------: | ----------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultTTL` |  `number` (ms) |         `0` | Default TTL applied when `set(key, value)` is called without a `ttl`. `0` disables expiry.                                                                                                                                                                                                     |
| `onExpire`   |     `Function` | `undefined` | Optional callback called when an entry expires: `(key, value) => void`. Callback errors are swallowed.                                                                                                                                                                                         |
| `now`        | `() => number` |   `nowMs()` | Injected clock in milliseconds, matching the rate limiters. Expiry is the one behaviour here that cannot be observed without a clock, so this is what turns "assert it expired after 150 ms" from a sleep into an exact assertion — see [Testing](#testing-expires-against-an-injected-clock). |

## API

- `set(key, value, ttl?)` — Set a value for `key`. Optionally provide `ttl` in milliseconds to override the map's `defaultTTL`. Returns the map instance to allow chaining.

  `ttl` accepts a number or a numeric string, or the options object `{ ttl }` for parity with `PowerCache.set`. `Infinity`, `null`/`undefined` and `0` all mean **no expiry**. Anything else throws a `TypeError` — a value that is not a number made every expiry comparison false, so the entry silently **never expired**, which is the worst failure direction a TTL container has. A **negative** `ttl` throws a `RangeError` rather than being treated as no expiry. The rules are the same ones `PowerCache` uses, from one shared validator, so the two classes cannot drift apart again.

- `get(key)` — Retrieve the value for `key` or `undefined` if it is missing or expired. Access will lazily purge expired entries.

- `has(key)` — Boolean indicating whether the key exists and is not expired.

- `delete(key)` — Remove an entry. Returns `true` if an entry was removed.

- `clear()` — Remove all entries immediately.

- `touch(key, ttl?)` — Refresh the TTL of an existing key; returns `true` when the TTL was updated.

- `size` (getter) — Number of **resident** entries, i.e. `Map.size`. Expired-but-not-yet-collected entries are resident and are counted, so this is an O(1) property read with no side effects. (Before 2.0 this getter swept expired entries and fired `onExpire` as a side effect; a property read with a callback side effect is an operation wearing a property's syntax. Use `purge()` when you mean to collect.)
- `expiredCount` (getter) — How many resident entries are past their expiry and awaiting collection. The live count is `size - expiredCount`. Read-only: does not sweep and does not fire `onExpire`, so it is safe as a diagnostic. O(k) in the number of entries that have a TTL, which is why the hot path reads `size` and this is for reporting.
- `purge()` — Collect every entry already past its expiry, firing `onExpire` for each. Returns how many were removed. The explicit form of what `size` used to do implicitly.

- `dispose()` — Release the instance. Works with `using` / `await using`. **Afterwards `set()` throws** — see [Disposal](#disposal).

- `[Symbol.dispose]()` — Alias for `dispose()`, so `using map = new PowerTTLMap(…)` releases it at scope exit.

## Disposal

```javascript
{
  using map = new PowerTTLMap(1000);
  map.set('a', 1);
} // dispose() runs here
```

**A disposed map is inert, not reusable: `set()` throws a `TypeError`.**

That is worth stating plainly because it used to be the opposite, and the
intermediate state was the worst of the available options. `dispose()` calls
`clear()` and then neutralises `clear` so a second call is a no-op — so an
instance that still accepted writes would accept an entry it could then **never
be emptied of**, short of waiting out that entry's TTL:

```javascript
const map = new PowerTTLMap(1000);
map.dispose();
map.set('b', 2); // used to succeed
map.clear(); // neutered: does nothing
map.get('b'); // 2, and no way to remove it
```

Refusing loudly beats accepting quietly, and it is consistent with the rest of
this class: `set()` already throws a `TypeError` on an unusable `ttl` and a
`RangeError` on a negative one. If you meant to keep using the map, call
`clear()` **before** disposing, or construct a new one.

**Reads keep working** and report an empty map — `get`, `has`, `size` and the
iterators do not throw. An emptied map reporting itself as empty is the truthful
answer, and a reader on a scope-exit path should not have to guard.

`touch()` and `delete()` also stay quiet rather than throwing. Both return early
on a key the emptied map does not hold, so neither can strand state — and a
`delete()` that threw after teardown would break the ordinary
`for (const k of map.keys()) map.delete(k)` cleanup loop.

The guard is one property read and one branch in `set()`, which is the hot path,
so the cost of the fix is one boolean field and a predictable branch.

- Iteration helpers: `entries()`, `keys()`, `values()` — Iterators over non-expired entries/keys/values respectively. These **collect** expired entries as they iterate, firing `onExpire`. That is deliberate and differs from `size`: iteration is an observable operation, so a caller can see it happen, whereas a property read cannot. `forEach(cb, thisArg?)` iterates non-expired entries calling `cb(value, key, map)`. `[Symbol.iterator]()` is an alias for `entries()`.

## Example

```javascript
import { PowerTTLMap } from 'performance-helpers/powerTTLMap';

// Example — manage expirable object URLs for served images

const urls = new PowerTTLMap(30_000); // default TTL 30s

// Store an object URL for a generated image and revoke it on expiry
function storePreview(id, objectUrl) {
  urls.set(id, objectUrl);
}

urls.set('img-1', URL.createObjectURL(blob));

// register onExpire to revoke underlying resources when entries age out
const m = new PowerTTLMap(30_000);
m.set('img-1', URL.createObjectURL(blob));
m.onExpire = (key, value) => {
  try {
    URL.revokeObjectURL(value);
  } catch (e) {
    /* ignore */
  }
};

if (m.has('img-1')) console.log('preview ready');
```

## Testing: expires against an injected clock

Everything else here is synchronously observable. Expiry is not — it is the one
behaviour that only happens as the clock moves, so testing it the obvious way
means sleeping and then racing the clock:

```js
// Flaky on a loaded machine, and slow on a fast one.
const m = new PowerTTLMap({ defaultTTL: 100 });
m.set('k', 1);
await new Promise((r) => setTimeout(r, 150));
expect(m.get('k')).toBeUndefined();
```

Pass `now` and the assertion states what it means instead of guessing how long
to wait:

```js
let clock = 0;
const m = new PowerTTLMap({ defaultTTL: 100, now: () => clock });
m.set('k', 1);
clock = 100;
expect(m.get('k')).toBe(1); // alive AT its TTL
clock = 102;
expect(m.get('k')).toBeUndefined();
```

That second assertion is the part worth internalising: an entry is stored with
`expiresAt = now + ttl + 1` and read back as `now > expiresAt`, so it survives
_at_ exactly its TTL and lapses immediately after. A test that expects it gone at
`clock = 100` will fail, and the reason is a deliberate off-by-one — an entry
that vanished exactly at its TTL would be shorter-lived than the caller asked
for. `test/invariants.test.js` pins all three of those positions so a later
"simplification" of the `+ 1` fails rather than passing quietly.

The same option exists on `PowerThrottle`, `PowerGCRA`, `PowerSlidingWindow`
and `PowerRateLimit`, where it is checked by a shared precedence rule: an
injected clock always wins over a per-call `now`, because a limiter that faked
its clock is a limiter under test.
