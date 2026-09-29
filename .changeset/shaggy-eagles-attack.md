---
'performance-helpers': minor
---

Adds an injectable clock to `PowerCache`, completing the family.

`PowerThrottle`, `PowerGCRA`, `PowerSlidingWindow`, `PowerRateLimit` and
`PowerTTLMap` have taken a `now` option since 2.0. `PowerCache` was the last
one without it, and it is the helper where it mattered most: TTL expiry is the
only behaviour it has that cannot be observed synchronously, so testing it
meant a sleep — a guess in both directions, since too short asserts on a live
entry and too long taxes every run.

```js
let clock = 0;
const cache = new PowerCache({ defaultTTL: 100, now: () => clock });
cache.set('k', 'v');
clock = 100;
cache.get('k'); // 'v'  — alive AT its TTL
clock = 102;
cache.get('k'); // undefined
```

`now` is declared in `PowerCacheOptions`, so a typo is a type error. Existing
callers are unaffected: the default is `nowMs()` exactly as before.

The change is one binding in the constructor and `nowMs()` → `this._now()` at
seven read sites. One of those is on the read path and is conditional
(`!ignoreExpiry && node.expiresAt ? this._now() : 0`), so an entry with no TTL
still reads the clock zero times — a property the cache had before this and
still has.

The two sleeps in `test/powerCache.getorset.test.js` that let a 1 ms TTL lapse
are now exact, which is the point: they asserted "not yet", a condition
`vi.waitFor` cannot poll for, so a sleep was the only tool available and a
guess was the only option it offered.
